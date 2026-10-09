import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Linking, Modal, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { api, storage, useSocialReady } from '../state/session';
import { getWalletSession, localEvmSigner, withDeviceAccounts } from '../state/walletStore';
import { encodeFunctionData, parseUnits } from 'viem';
import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import * as Keychain from 'react-native-keychain';
import { createAssociatedTokenAccountInstruction, createTransferCheckedInstruction, getAssociatedTokenAddress } from '@solana/spl-token';
import { kivoTheme } from '../theme/kivoTheme';
import Svg, { Path, Polygon, Circle } from 'react-native-svg';

type Chain = 'ethereum' | 'base' | 'arbitrum' | 'solana';
type Plan = 'monthly' | 'annual';
type SubjectType = 'profile' | 'channel';
type PendingPayment = { txHash: string; chain: Chain; plan: Plan };

const CHAINS: Chain[] = ['base', 'ethereum', 'arbitrum', 'solana'];
const PLANS: Plan[] = ['monthly', 'annual'];
const CHAIN_META: Record<Chain, { label: string; color: string; subtitle: string }> = {
  ethereum: { label: 'Ethereum', color: '#8B9CFF', subtitle: 'Ethereum Mainnet' },
  base: { label: 'Base', color: '#4C7DFF', subtitle: 'Base Mainnet' },
  arbitrum: { label: 'Arbitrum One', color: '#8AB4F8', subtitle: 'Arbitrum One' },
  solana: { label: 'Solana', color: '#8BDFC5', subtitle: 'Solana Mainnet' },
};
const EVM_RECIPIENT = '0x0b7736fd7b606d9958e9c2ec5fbc9347078264d5';
const SOLANA_RECIPIENT = '2ApuoLHkMnhX13w6wnSfnP64sbBAgCABiqfHeFYAamki';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGZwyTDt1v';

// Local stores only help recover a submitted hash; the server must still verify it on-chain.
const PENDING_KEYCHAIN_SERVICE = 'com.kivo.verification-pending';

function isValidPendingRecord(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as { txHash?: unknown; chain?: unknown; plan?: unknown };
    return typeof parsed.txHash === 'string' &&
      (parsed.chain === 'ethereum' || parsed.chain === 'base' || parsed.chain === 'arbitrum' || parsed.chain === 'solana') &&
      (parsed.plan === 'monthly' || parsed.plan === 'annual') &&
      (parsed.chain === 'solana' ? /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(parsed.txHash) : /^0x[0-9a-fA-F]{64}$/.test(parsed.txHash));
  } catch {
    return false;
  }
}

async function readPendingRecord(key: string, service: string): Promise<string | null> {
  try {
    const value = await storage.getItem(key);
    if (value && isValidPendingRecord(value)) return value;
  } catch {}
  try {
    const credentials = await Keychain.getGenericPassword({ service });
    if (credentials && credentials.username === key && isValidPendingRecord(credentials.password)) return credentials.password;
  } catch {}
  return null;
}

async function savePendingRecord(key: string, service: string, value: string): Promise<boolean> {
  let saved = false;
  try { await storage.setItem(key, value); saved = true; } catch {}
  try {
    await Keychain.setGenericPassword(key, value, {
      service,
      accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    saved = true;
  } catch {}
  return saved;
}

async function clearPendingRecord(key: string, service: string): Promise<void> {
  try { await storage.removeItem?.(key); } catch {}
  try { await Keychain.resetGenericPassword({ service }); } catch {}
}

export function VerificationScreen({ subjectType, subjectId, subjectName, onBack }: {
  subjectType: SubjectType;
  subjectId: string;
  subjectName: string;
  onBack: () => void;
}) {
  const socialReady = useSocialReady();
  const [plan, setPlan] = useState<Plan>('monthly');
  const [chain, setChain] = useState<Chain>('base');
  const [networkPickerOpen, setNetworkPickerOpen] = useState(false);
  const [pending, setPending] = useState<PendingPayment | null>(null);
  const [pendingLoaded, setPendingLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Choose a plan and network to get started.');
  const [receipt, setReceipt] = useState<any>(null);
  const [alreadyVerified, setAlreadyVerified] = useState(false);
  const [pendingPersistenceWarning, setPendingPersistenceWarning] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const receiptStorageKey = `kivo:verification-receipt:${subjectType}:${subjectId}`;
  const storageKey = `kivo:verification-pending:${subjectType}:${subjectId}`;
  const keychainService = `${PENDING_KEYCHAIN_SERVICE}.${subjectType}.${encodeURIComponent(subjectId)}`;
  const pendingRecovery = pending as PendingPayment | null;

  useEffect(() => {
    let active = true;
    void Promise.resolve(storage.getItem(receiptStorageKey)).then(raw => {
      if (!active || !raw) return;
      try { setReceipt(JSON.parse(raw)); } catch { void Promise.resolve(storage.removeItem?.(receiptStorageKey)).catch(() => {}); }
    }).catch(() => {});

    // Recover the server-confirmed receipt after reinstall or on another device.
    // A historical receipt never activates a badge; verificationStatus remains authoritative.
    void api.latestVerificationReceipt(subjectType, subjectId).then(serverReceipt => {
      if (!active || !serverReceipt) return;
      const recovered = {
        id: serverReceipt.id,
        plan: serverReceipt.plan,
        chain: serverReceipt.chain,
        token: 'USDC',
        amount: serverReceipt.amount,
        txHash: serverReceipt.txHash,
        payer: serverReceipt.payer,
        paidAt: serverReceipt.paidAt,
        expiresAt: serverReceipt.expiresAt,
        explorerUrl: serverReceipt.explorerUrl,
        status: serverReceipt.status,
      };
      setReceipt(recovered);
      void Promise.resolve(storage.setItem(receiptStorageKey, JSON.stringify(recovered))).catch(() => {});
    }).catch(() => {});
    return () => { active = false; };
  }, [receiptStorageKey, subjectType, subjectId]);

  useEffect(() => {
    let active = true;
    void readPendingRecord(storageKey, keychainService).then(async raw => {
      if (!active) return;
      if (raw) {
        const parsed = JSON.parse(raw) as { txHash?: unknown; chain?: unknown; plan?: unknown };
        const valid = typeof parsed.txHash === 'string' &&
          (parsed.chain === 'ethereum' || parsed.chain === 'base' || parsed.chain === 'arbitrum' || parsed.chain === 'solana') &&
          (parsed.plan === 'monthly' || parsed.plan === 'annual') &&
          (parsed.chain === 'solana' ? /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(parsed.txHash) : /^0x[0-9a-fA-F]{64}$/.test(parsed.txHash));
        if (valid) {
          const restored = { txHash: parsed.txHash as string, chain: parsed.chain as Chain, plan: parsed.plan as Plan };
          setPending(restored);
          setChain(restored.chain);
          setPlan(restored.plan);
          setStatus('A payment was already submitted. Retry verification; do not pay again.');
        } else {
          await clearPendingRecord(storageKey, keychainService);
        }
      }
    }).catch(() => {}).finally(() => { if (active) setPendingLoaded(true); });
    return () => { active = false; };
  }, [storageKey, keychainService]);

  useEffect(() => {
    let active = true;
    void api.verificationStatus(subjectType, subjectId).then(current => {
      if (!active) return;
      if (current.isVerified) {
        setAlreadyVerified(true);
        setStatus(current.permanent ? 'Blue Star verification is active.' : `Verified until ${current.expiresAt ? new Date(current.expiresAt).toLocaleDateString() : 'expiry unavailable'}.`);
        setPending(null);
        void clearPendingRecord(storageKey, keychainService);
      } else {
        // A locally saved receipt is history, not proof that a subscription is still active.
        setAlreadyVerified(false);
      }
    }).catch(() => {});
    return () => { active = false; };
  }, [subjectType, subjectId, storageKey]);

  const pay = async () => {
    if (busy || !pendingLoaded) return;
    if (!socialReady) {
      Alert.alert('Kivo', 'Turn on chats first so your account can complete verification.');
      return;
    }
    if (!getWalletSession()) {
      Alert.alert('Kivo wallet', 'Unlock your Kivo wallet before paying.');
      return;
    }
    setBusy(true);
    let pendingForAttempt = pending;
    let pendingPersistenceFailedForAttempt = false;
    try {
      const selectedPlan = pending?.plan ?? plan;
      const selectedChain = pending?.chain ?? chain;
      let txHash = pending?.txHash ?? '';
      if (!pending && selectedChain === 'solana') {
        txHash = await withDeviceAccounts('Approve Blue Star USDC payment', async ({ solana }) => {
          const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
          const mint = new PublicKey(USDC_MINT);
          const recipient = new PublicKey(SOLANA_RECIPIENT);
          const sourceAta = await getAssociatedTokenAddress(mint, solana.publicKey);
          if (!(await connection.getAccountInfo(sourceAta))) throw new Error('Your Kivo wallet has no Solana USDC token account. Add USDC on Solana before paying.');
          const destinationAta = await getAssociatedTokenAddress(mint, recipient);
          const transaction = new Transaction();
          if (!(await connection.getAccountInfo(destinationAta))) transaction.add(createAssociatedTokenAccountInstruction(solana.publicKey, destinationAta, recipient, mint));
          transaction.add(createTransferCheckedInstruction(sourceAta, mint, destinationAta, solana.publicKey, selectedPlan === 'annual' ? 5_000_000n : 1_000_000n, 6));
          const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
          transaction.feePayer = solana.publicKey;
          transaction.recentBlockhash = blockhash;
          const signature = await connection.sendTransaction(transaction, [solana], { skipPreflight: false, preflightCommitment: 'confirmed' });
          pendingForAttempt = { txHash: signature, chain: selectedChain, plan: selectedPlan };
          setPending(pendingForAttempt);
          const saved = await savePendingRecord(storageKey, keychainService, JSON.stringify(pendingForAttempt));
          pendingPersistenceFailedForAttempt = !saved;
          setPendingPersistenceWarning(!saved);
          await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
          return signature;
        });
      } else if (!pending) {
        const evmChain = selectedChain as 'ethereum' | 'base' | 'arbitrum';
        const chainIds = { ethereum: 1, base: 8453, arbitrum: 42161 } as const;
        const usdc = { ethereum: '0xA0b86991c6218b36c1d19d4a2e9Eb0cE3606eB48', base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', arbitrum: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' } as const;
        const signer = await localEvmSigner();
        await signer.ensureChain(chainIds[evmChain]);
        const data = encodeFunctionData({
          abi: [{ type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }], outputs: [{ type: 'bool' }] }],
          functionName: 'transfer',
          args: [EVM_RECIPIENT, parseUnits(selectedPlan === 'annual' ? '5' : '1', 6)],
        });
        txHash = await signer.sendTransaction({ to: usdc[evmChain], data, value: 0n, chainId: chainIds[evmChain] });
        pendingForAttempt = { txHash, chain: selectedChain, plan: selectedPlan };
        setPending(pendingForAttempt);
        const saved = await savePendingRecord(storageKey, keychainService, JSON.stringify(pendingForAttempt));
        pendingPersistenceFailedForAttempt = !saved;
        setPendingPersistenceWarning(!saved);
      }
      setStatus('Waiting for blockchain confirmation…');
      setStatus('Verifying payment with Kivo…');
      let result: any;
      for (let attempt = 0; ; attempt++) {
        try {
          result = await api.purchaseVerification({ subjectType, subjectId, plan: selectedPlan, chain: selectedChain, txHash });
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : '';
          const httpStatus = typeof error === 'object' && error !== null && 'status' in error
            ? Number((error as { status?: unknown }).status) : 0;
          // A 429 must not be retried inside the same minute window. The old
          // loop could send up to 15 POSTs and exhaust the purchase limiter.
          if (httpStatus === 429 || attempt >= 2 ||
              !/confirm|temporarily unavailable|not finalized|timeout|network|fetch/i.test(message)) throw error;
          await new Promise(resolve => setTimeout(resolve, attempt === 0 ? 5_000 : 15_000));
        }
      }
      setPending(null);
      await clearPendingRecord(storageKey, keychainService);
      setPendingPersistenceWarning(false);
      setReceipt(result);
      await Promise.resolve(storage.setItem(receiptStorageKey, JSON.stringify(result))).catch(() => {});
      setAlreadyVerified(true);
      setStatus('Payment confirmed. Blue Star verification is active.');
      Alert.alert('Blue Star activated', 'Payment confirmed. Your verification receipt is ready.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not verify payment.';
      if (pendingForAttempt) {
        setPending(pendingForAttempt);
        setStatus(`${pendingPersistenceFailedForAttempt ? 'Recovery storage could not be saved. Keep this screen open and retry verification before leaving. ' : ''}Payment submitted. Retry verification; do not pay again. ${message}`);
        Alert.alert('Payment submitted', 'Retry verification for the existing transaction. Do not pay again.');
      } else {
        setStatus(message);
        Alert.alert('Payment not completed', message);
      }
    } finally {
      setBusy(false);
    }
  };

  // Automatically retry the saved transaction hash after a delay. This calls
  // server-side verification only and never submits another wallet transfer.
  useEffect(() => {
    if (!pending || alreadyVerified || !pendingLoaded) return;
    const timer = setInterval(() => {
      if (!busy) void pay();
    }, 60_000);
    return () => clearInterval(timer);
  }, [pending?.txHash, pending?.chain, pending?.plan, alreadyVerified, pendingLoaded, busy]);

  const connected = Boolean(getWalletSession());
  const receiptPayer = receipt?.payer ?? receipt?.payer_address ?? 'Shown on verified payment record';
  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Pressable onPress={onBack} accessibilityRole="button" style={styles.back}><Text style={styles.backText}>‹</Text></Pressable>
        <View style={styles.headerCopy}><Text style={styles.title}>Blue Star verification</Text><Text style={styles.subtitle}>{subjectName}</Text></View>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        {busy || pending ? (
          <View style={styles.card}>
            <Text style={styles.successTitle}>Payment progress</Text>
            {(['Wallet transaction submitted', 'Blockchain confirmation', 'Kivo verification', 'Blue Star activation'] as const).map((step, index) => {
              const activeIndex = /Payment confirmed|Blue Star verification is active/i.test(status) ? 4 : /Verifying payment with Kivo/i.test(status) ? 2 : /Waiting for blockchain|Waiting for Solana/i.test(status) ? 1 : /submitted|Retry verification|temporarily unavailable|confirm/i.test(status) ? 2 : busy ? 0 : 1;
              const done = index < activeIndex || (alreadyVerified && Boolean(receipt));
              return <View key={step} style={styles.progressRow}><View style={[styles.progressDot, done && styles.progressDotDone, index === activeIndex && styles.progressDotActive]}><Text style={styles.progressDotText}>{done ? '✓' : String(index + 1)}</Text></View><Text style={[styles.progressLabel, (done || index === activeIndex) && styles.progressLabelActive]}>{step}</Text></View>;
            })}
            <Text style={styles.status} accessibilityLiveRegion="polite">{status}</Text>
            {pending ? <Pressable style={styles.secondaryButton} onPress={() => void pay()}><Text style={styles.secondaryText}>Retry verification (no new payment)</Text></Pressable> : null}
          </View>
        ) : alreadyVerified && !receipt ? (
          <View style={styles.card}>
            <Text style={styles.successTitle}>★ Blue Star already active</Text>
            <Text style={styles.description}>{status}</Text>
            <Pressable style={styles.payButton} onPress={onBack}><Text style={styles.payText}>Done</Text></Pressable>
          </View>
        ) : !receipt ? (
          <View style={styles.card}>
            <Text style={styles.description}>Choose your plan and network. Kivo checks the blockchain payment before activating your Blue Star badge. Your wallet will ask you to approve the USDC transfer.</Text>
            <Text style={styles.label}>Plan</Text>
            <View style={styles.options}>{PLANS.map(item => <Pressable key={item} disabled={busy || Boolean(pending)} onPress={() => setPlan(item)} style={[styles.option, plan === item && styles.optionActive, Boolean(pending) && styles.optionDisabled]}><UsdcLogo /><View style={styles.planCopy}><Text style={[styles.optionText, plan === item && styles.optionTextActive]}>{item === 'annual' ? '$5 USDC / year' : '$1 USDC / month'}</Text><Text style={[styles.planHint, plan === item && styles.optionTextActive]}>{item === 'annual' ? '365 days · Best value' : '30 days'}</Text></View>{plan === item ? <Text style={styles.planSelected}>✓</Text> : <View style={styles.planRadio} />}</Pressable>)}</View>
            <Text style={styles.label}>Network</Text>
            <Pressable accessibilityRole="button" accessibilityLabel={`Choose network. Selected: ${CHAIN_META[chain].label}`} disabled={busy || Boolean(pending)} onPress={() => setNetworkPickerOpen(true)} style={[styles.networkSelector, Boolean(pending) && styles.optionDisabled]}>
              <NetworkLogo chain={chain} />
              <View style={styles.networkCopy}><Text style={styles.networkName}>{CHAIN_META[chain].label}</Text><Text style={styles.networkSubtitle}>{CHAIN_META[chain].subtitle}</Text></View>
              <Text style={styles.networkChevron}>⌄</Text>
            </Pressable>
            <Modal visible={networkPickerOpen} transparent animationType="fade" onRequestClose={() => setNetworkPickerOpen(false)}>
              <Pressable style={styles.modalBackdrop} onPress={() => setNetworkPickerOpen(false)}>
                <Pressable style={styles.pickerSheet} onPress={() => {}}>
                  <View style={styles.pickerHandle} />
                  <View style={styles.pickerHeader}><View><Text style={styles.pickerTitle}>Choose network</Text><Text style={styles.pickerSubtitle}>Pay with USDC on your selected network</Text></View><Pressable accessibilityRole="button" accessibilityLabel="Close network picker" onPress={() => setNetworkPickerOpen(false)} style={styles.pickerClose}><Text style={styles.pickerCloseText}>×</Text></Pressable></View>
                  {CHAINS.map(item => <Pressable key={item} accessibilityRole="button" onPress={() => { setChain(item); setNetworkPickerOpen(false); }} style={[styles.networkOption, chain === item && styles.networkOptionActive]}>
                    <NetworkLogo chain={item} />
                    <View style={styles.networkCopy}><Text style={styles.networkName}>{CHAIN_META[item].label}</Text><Text style={styles.networkSubtitle}>{CHAIN_META[item].subtitle}</Text></View>
                    {chain === item ? <Text style={styles.selectedMark}>✓</Text> : <Text style={styles.networkChevron}>›</Text>}
                  </Pressable>)}
                  <Text style={styles.pickerFootnote}>Make sure your wallet has USDC on the selected network.</Text>
                </Pressable>
              </Pressable>
            </Modal>
            <View style={styles.walletState}><View style={styles.dot}/><Text style={styles.walletText}>{connected ? 'Kivo wallet connected' : 'Unlock Kivo wallet to continue'}</Text></View>
            <Pressable disabled={busy || !pendingLoaded || !connected || !socialReady} onPress={() => pending ? void pay() : setConfirmOpen(true)} style={[styles.payButton, (busy || !pendingLoaded || !connected || !socialReady) && styles.buttonDisabled]}>
              {busy ? <ActivityIndicator color={kivoTheme.colors.backgroundDeep}/> : <Text style={styles.payText}>{pending ? 'Retry verification' : `Pay ${plan === 'annual' ? '$5' : '$1'} USDC`}</Text>}
            </Pressable>
            <Text style={styles.status} accessibilityLiveRegion="polite">{status}</Text>
            {pendingRecovery ? <Pressable style={styles.secondaryButton} onPress={() => Share.share({ message: `Kivo Blue Star payment recovery\\nSubject: ${subjectType} ${subjectId}\\nNetwork: ${pendingRecovery.chain}\\nPlan: ${pendingRecovery.plan}\\nTransaction: ${pendingRecovery.txHash}\\nRetry verification in Kivo; do not pay again.` })}><Text style={styles.secondaryText}>Share transaction recovery details</Text></Pressable> : null}
            <Text style={styles.finePrint}>No funds move until you approve the transaction in your wallet.</Text>
          </View>
        ) : (
          <View style={styles.card}>
            <Text style={styles.successTitle}>{alreadyVerified ? '★ Blue Star activated' : 'Blue Star payment receipt'}</Text>
            <Text style={styles.description}>{alreadyVerified ? 'Your subscription is currently active. Keep this receipt for your records.' : 'This receipt records the confirmed payment. Your verification is not currently active; renew to restore the badge.'}</Text>
            <ReceiptRow label="Subject" value={subjectName}/>
            <ReceiptRow label="Plan" value={`${receipt.plan === 'annual' ? 'Annual' : 'Monthly'} · ${receipt.amount} USDC`}/>
            <ReceiptRow label="Network" value={receipt.chain}/>
            <ReceiptRow label="Transaction" value={receipt.txHash}/>
            <ReceiptRow label="Payer" value={receiptPayer}/>
            <View style={styles.qrWrap}><QRCode value={receipt.explorerUrl || receipt.txHash} size={128} backgroundColor="#FFFFFF" color="#062F2C"/><Text style={styles.qrCaption}>Scan to view transaction</Text></View>
            <ReceiptRow label="Paid" value={new Date(receipt.paidAt).toLocaleString()}/>
            <ReceiptRow label="Receipt ID" value={receipt.id ?? 'Verified payment'}/>
            <ReceiptRow label="Valid until" value={new Date(receipt.expiresAt).toLocaleDateString()}/>
            <Pressable style={styles.secondaryButton} onPress={() => Share.share({ message: `Kivo Blue Star payment receipt\nSubject: ${subjectType} — ${subjectName}\nCurrent verification: ${alreadyVerified ? 'Active' : 'Inactive / expired'}\nPlan: ${receipt.plan === 'annual' ? 'Annual (365 days)' : 'Monthly (30 days)'}\nAmount: ${receipt.amount} USDC\nNetwork: ${receipt.chain}\nTransaction: ${receipt.txHash}\nPayer: ${receiptPayer}\nPaid: ${new Date(receipt.paidAt).toLocaleString()}\nValid until: ${new Date(receipt.expiresAt).toLocaleString()}\nReceipt ID: ${receipt.id ?? 'Unavailable'}\nExplorer: ${receipt.explorerUrl}` })}><Text style={styles.secondaryText}>Share complete receipt</Text></Pressable>
            <Pressable style={styles.secondaryButton} onPress={() => Linking.openURL(receipt.explorerUrl).catch(() => Alert.alert('Kivo', 'Could not open the transaction explorer.'))}><Text style={styles.secondaryText}>View transaction</Text></Pressable>
            {Number(receipt.expiresAt) <= Date.now() ? <Pressable style={styles.payButton} onPress={() => { setReceipt(null); setAlreadyVerified(false); setStatus('Your previous verification has expired. Choose a plan to renew.'); }}><Text style={styles.payText}>Renew Blue Star</Text></Pressable> : null}
            <Pressable style={styles.payButton} onPress={onBack}><Text style={styles.payText}>Done</Text></Pressable>
          </View>
        )}
      <Modal visible={confirmOpen} transparent animationType="fade" onRequestClose={() => setConfirmOpen(false)}>
        <View style={styles.confirmBackdrop}>
          <View style={styles.confirmCard}>
            <Text style={styles.successTitle}>Confirm payment</Text>
            <Text style={styles.description}>Review these details before your wallet opens. No funds move until you approve in your wallet.</Text>
            <ReceiptRow label="Plan" value={plan === 'annual' ? 'Annual · 365 days' : 'Monthly · 30 days'}/>
            <ReceiptRow label="Amount" value={`${plan === 'annual' ? '$5' : '$1'} USDC`}/>
            <ReceiptRow label="Network" value={CHAIN_META[chain].label}/>
            <View style={styles.confirmActions}>
              <Pressable style={styles.secondaryButton} onPress={() => setConfirmOpen(false)}><Text style={styles.secondaryText}>Cancel</Text></Pressable>
              <Pressable style={styles.payButton} onPress={() => { setConfirmOpen(false); void pay(); }}><Text style={styles.payText}>Confirm and pay</Text></Pressable>
            </View>
          </View>
        </View>
      </Modal>
      </ScrollView>
    </View>
  );
}

function ReceiptRow({ label, value }: { label: string; value: string }) {
  return <View style={styles.receiptRow}><Text style={styles.receiptLabel}>{label}</Text><Text selectable style={styles.receiptValue}>{value}</Text></View>;
}

function UsdcLogo() {
  return <Svg width={32} height={32} viewBox="0 0 100 100"><Circle cx="50" cy="50" r="48" fill="#2775CA"/><Path d="M64 34c-3-3-8-5-14-5-10 0-17 5-17 13 0 7 5 10 16 12 8 2 11 3 11 7s-4 6-10 6c-7 0-12-2-16-6l-7 8c5 5 12 8 21 8v9h6v-9c11-1 18-7 18-16 0-8-6-12-17-14-8-2-10-3-10-6 0-3 3-5 8-5s9 2 12 5Z" fill="#FFFFFF"/><Path d="M48 12v10M48 78v10" stroke="#FFFFFF" strokeWidth="5" strokeLinecap="round"/></Svg>;
}

function NetworkLogo({ chain }: { chain: Chain }) {
  const size = 38;
  if (chain === 'ethereum') return <View style={[styles.networkMark, { backgroundColor: '#627EEA18' }]}><Svg width={25} height={30} viewBox="0 0 256 417"><Polygon points="127.9,0 0,211.9 127.9,154.4" fill="#8C9EFF"/><Polygon points="127.9,0 255.8,211.9 127.9,154.4" fill="#62688F"/><Polygon points="0,236.2 127.9,417 127.9,281.8" fill="#8C9EFF"/><Polygon points="255.8,236.2 127.9,417 127.9,281.8" fill="#62688F"/><Polygon points="0,211.9 127.9,281.8 127.9,154.4" fill="#62688F"/><Polygon points="255.8,211.9 127.9,281.8 127.9,154.4" fill="#454A75"/></Svg></View>;
  if (chain === 'base') return <View style={[styles.networkMark, { backgroundColor: '#0052FF18' }]}><Svg width={27} height={27} viewBox="0 0 100 100"><Circle cx="50" cy="50" r="50" fill="#0052FF"/><Path d="M50 22a28 28 0 1 0 27.2 34H50V44h27.2A28 28 0 0 0 50 22Z" fill="#FFFFFF"/></Svg></View>;
  if (chain === 'arbitrum') return <View style={[styles.networkMark, { backgroundColor: '#21314718' }]}><Svg width={29} height={29} viewBox="0 0 100 100"><Path d="M50 3 91 27v46L50 97 9 73V27Z" fill="#213147"/><Path d="M47 19 26 58l8 14 25-45Z" fill="#28A0F0"/><Path d="m60 37 16 28-8 14-21-37Z" fill="#FFFFFF"/><Path d="M39 70 50 50l11 19-7 12H46Z" fill="#28A0F0"/></Svg></View>;
  return <View style={[styles.networkMark, { backgroundColor: '#9945FF18' }]}><Svg width={29} height={29} viewBox="0 0 100 100"><Path d="M22 32c2-2 4-3 7-3h48c5 0 7 6 3 9L69 48c-2 2-4 3-7 3H14c-5 0-7-6-3-9Z" fill="#9945FF"/><Path d="M22 52c2-2 4-3 7-3h48c5 0 7 6 3 9L69 68c-2 2-4 3-7 3H14c-5 0-7-6-3-9Z" fill="#14F195"/><Path d="M22 72c2-2 4-3 7-3h25c5 0 7 6 3 9l-7 7c-2 2-4 3-7 3H14c-5 0-7-6-3-9Z" fill="#9945FF"/></Svg></View>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: kivoTheme.colors.background },
  confirmBackdrop: { flex: 1, backgroundColor: 'rgba(0, 15, 13, 0.78)', justifyContent: 'center', padding: 18 },
  confirmCard: { borderWidth: 1, borderColor: kivoTheme.colors.border, borderRadius: 20, padding: 18, gap: 12, backgroundColor: kivoTheme.colors.surface },
  confirmActions: { flexDirection: 'row', gap: 10, marginTop: 6 },
  progressRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 38 },
  progressDot: { width: 26, height: 26, borderRadius: 13, borderWidth: 1, borderColor: kivoTheme.colors.border, alignItems: 'center', justifyContent: 'center' },
  progressDotDone: { backgroundColor: kivoTheme.colors.accent, borderColor: kivoTheme.colors.accent },
  progressDotActive: { borderColor: kivoTheme.colors.accent, borderWidth: 2 },
  progressDotText: { color: kivoTheme.colors.text, fontSize: 11, fontWeight: '900' },
  progressLabel: { color: kivoTheme.colors.textMuted, fontSize: 13 },
  progressLabelActive: { color: kivoTheme.colors.text, fontWeight: '800' },
  qrWrap: { alignItems: 'center', gap: 8, padding: 14, backgroundColor: '#FFFFFF', borderRadius: 12, alignSelf: 'center' },
  qrCaption: { color: '#062F2C', fontSize: 11, fontWeight: '700' },
  header: { minHeight: 68, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, borderBottomWidth: 1, borderBottomColor: kivoTheme.colors.border, backgroundColor: kivoTheme.colors.backgroundDeep },
  back: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: kivoTheme.colors.surface, marginRight: 12 },
  backText: { color: kivoTheme.colors.text, fontSize: 28, lineHeight: 30 },
  headerCopy: { flex: 1, gap: 2 },
  title: { color: kivoTheme.colors.text, fontSize: 20, fontWeight: '800' },
  subtitle: { color: kivoTheme.colors.textMuted, fontSize: 13 },
  content: { padding: 12, paddingBottom: 20, gap: 8 },
  card: { padding: 10, borderRadius: 14, borderWidth: 1, borderColor: kivoTheme.colors.border, backgroundColor: kivoTheme.colors.surface, gap: 7 },
  description: { color: kivoTheme.colors.textMuted, fontSize: 12, lineHeight: 16 },
  label: { color: kivoTheme.colors.text, fontSize: 12, fontWeight: '800', marginTop: 1 },
  options: { flexDirection: 'column', gap: 9 },
  networkSelector: { minHeight: 62, borderWidth: 1, borderColor: kivoTheme.colors.border, borderRadius: 14, paddingHorizontal: 13, paddingVertical: 10, backgroundColor: kivoTheme.colors.backgroundDeep, flexDirection: 'row', alignItems: 'center', gap: 12 },
  networkMark: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  networkCopy: { flex: 1, gap: 3 },
  networkName: { color: kivoTheme.colors.text, fontSize: 14, fontWeight: '800' },
  networkSubtitle: { color: kivoTheme.colors.textMuted, fontSize: 11 },
  networkChevron: { color: kivoTheme.colors.textMuted, fontSize: 25, paddingHorizontal: 5 },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0, 15, 13, 0.72)', justifyContent: 'center', alignItems: 'center', padding: 12 },
  pickerSheet: { width: '100%', maxWidth: 360, maxHeight: '58%', borderWidth: 1, borderColor: kivoTheme.colors.border, borderRadius: 18, padding: 10, paddingBottom: 12, backgroundColor: kivoTheme.colors.surface, gap: 6 },
  pickerHandle: { alignSelf: 'center', width: 28, height: 3, borderRadius: 2, backgroundColor: kivoTheme.colors.border, marginBottom: 2 },
  pickerHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  pickerTitle: { color: kivoTheme.colors.text, fontSize: 16, fontWeight: '900' },
  pickerSubtitle: { color: kivoTheme.colors.textMuted, fontSize: 11, marginTop: 3 },
  pickerClose: { width: 30, height: 30, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: kivoTheme.colors.backgroundDeep },
  pickerCloseText: { color: kivoTheme.colors.text, fontSize: 24, lineHeight: 26 },
  networkOption: { minHeight: 46, borderWidth: 1, borderColor: kivoTheme.colors.border, borderRadius: 12, paddingHorizontal: 9, paddingVertical: 6, backgroundColor: kivoTheme.colors.backgroundDeep, flexDirection: 'row', alignItems: 'center', gap: 9 },
  networkOptionActive: { borderColor: kivoTheme.colors.accent, backgroundColor: kivoTheme.colors.surfaceRaised },
  selectedMark: { color: kivoTheme.colors.accent, fontSize: 20, fontWeight: '900', paddingHorizontal: 5 },
  pickerFootnote: { color: kivoTheme.colors.textMuted, fontSize: 10, lineHeight: 14, marginTop: 1 },
  option: { minHeight: 62, flexDirection: 'row', alignItems: 'center', gap: 11, borderWidth: 1, borderColor: kivoTheme.colors.border, borderRadius: 15, paddingHorizontal: 13, paddingVertical: 11, backgroundColor: kivoTheme.colors.backgroundDeep },
  optionActive: { borderColor: kivoTheme.colors.accent, backgroundColor: kivoTheme.colors.accent },
  optionDisabled: { opacity: 0.6 },
  optionText: { color: kivoTheme.colors.text, fontSize: 14, fontWeight: '800' },
  planCopy: { flex: 1, gap: 3 },
  planHint: { color: kivoTheme.colors.textMuted, fontSize: 11 },
  planRadio: { width: 21, height: 21, borderRadius: 11, borderWidth: 1.5, borderColor: kivoTheme.colors.textMuted },
  planSelected: { width: 22, height: 22, borderRadius: 11, overflow: 'hidden', textAlign: 'center', textAlignVertical: 'center', color: kivoTheme.colors.backgroundDeep, backgroundColor: kivoTheme.colors.accent, fontSize: 14, fontWeight: '900' },
  optionTextActive: { color: kivoTheme.colors.backgroundDeep },
  walletState: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: kivoTheme.colors.success },
  walletText: { color: kivoTheme.colors.textMuted, fontSize: 13 },
  payButton: { minHeight: 50, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: kivoTheme.colors.accent, paddingHorizontal: 16 },
  buttonDisabled: { opacity: 0.55 },
  payText: { color: kivoTheme.colors.backgroundDeep, fontSize: 15, fontWeight: '900' },
  status: { color: kivoTheme.colors.textMuted, fontSize: 12, lineHeight: 18 },
  finePrint: { color: kivoTheme.colors.textMuted, fontSize: 11, lineHeight: 16 },
  successTitle: { color: kivoTheme.colors.success, fontSize: 18, fontWeight: '900' },
  receiptRow: { borderBottomWidth: 1, borderBottomColor: kivoTheme.colors.border, paddingVertical: 8, gap: 4 },
  receiptLabel: { color: kivoTheme.colors.textMuted, fontSize: 11, fontWeight: '800', textTransform: 'uppercase' },
  receiptValue: { color: kivoTheme.colors.text, fontSize: 13, lineHeight: 19 },
  secondaryButton: { minHeight: 44, borderRadius: 12, borderWidth: 1, borderColor: kivoTheme.colors.border, alignItems: 'center', justifyContent: 'center', padding: 12 },
  secondaryText: { color: kivoTheme.colors.text, fontWeight: '700' },
});
