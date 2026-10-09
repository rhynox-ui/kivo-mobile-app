import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { api, storage, useSocialReady } from '../state/session';
import { getWalletSession, localEvmSigner, withDeviceAccounts } from '../state/walletStore';
import { encodeFunctionData, parseUnits } from 'viem';
import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import * as Keychain from 'react-native-keychain';
import { createAssociatedTokenAccountInstruction, createTransferCheckedInstruction, getAssociatedTokenAddress } from '@solana/spl-token';
import { kivoTheme } from '../theme/kivoTheme';

type Chain = 'ethereum' | 'base' | 'arbitrum' | 'solana';
type Plan = 'monthly' | 'annual';
type SubjectType = 'profile' | 'channel';
type PendingPayment = { txHash: string; chain: Chain; plan: Plan };

const CHAINS: Chain[] = ['base', 'ethereum', 'arbitrum', 'solana'];
const PLANS: Plan[] = ['monthly', 'annual'];
const EVM_RECIPIENT = '0x0b7736fd7b606d9958e9c2ec5fbc9347078264d5';
const SOLANA_RECIPIENT = '2ApuoLHkMnhX13w6wnSfnP64sbBAgCABiqfHeFYAamki';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGZwyTDt1v';

// Local stores only help recover a submitted hash; the server must still verify it on-chain.
const PENDING_KEYCHAIN_SERVICE = 'com.kivo.verification-pending';

async function readPendingRecord(key: string, service: string): Promise<string | null> {
  try {
    const value = await storage.getItem(key);
    if (value) return value;
  } catch {}
  try {
    const credentials = await Keychain.getGenericPassword({ service });
    if (credentials && credentials.username === key) return credentials.password;
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
  const [plan, setPlan] = useState<Plan>('annual');
  const [chain, setChain] = useState<Chain>('base');
  const [pending, setPending] = useState<PendingPayment | null>(null);
  const [pendingLoaded, setPendingLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Choose a plan and network to get started.');
  const [receipt, setReceipt] = useState<any>(null);
  const [alreadyVerified, setAlreadyVerified] = useState(false);
  const [pendingPersistenceWarning, setPendingPersistenceWarning] = useState(false);
  const storageKey = `kivo:verification-pending:${subjectType}:${subjectId}`;
  const keychainService = `${PENDING_KEYCHAIN_SERVICE}.${subjectType}.${encodeURIComponent(subjectId)}`;

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
      let result: any;
      for (let attempt = 0; ; attempt++) {
        try {
          result = await api.purchaseVerification({ subjectType, subjectId, plan: selectedPlan, chain: selectedChain, txHash });
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : '';
          if (attempt >= 7 || !/confirm|temporarily unavailable|retry|not finalized/i.test(message)) throw error;
          await new Promise(resolve => setTimeout(resolve, Math.min(2500 + attempt * 1500, 9000)));
        }
      }
      setPending(null);
      await clearPendingRecord(storageKey, keychainService);
      setPendingPersistenceWarning(false);
      setReceipt(result);
      setAlreadyVerified(true);
      setStatus('Payment confirmed. Blue Star verification is active.');
      Alert.alert('Blue Star activated', 'Payment confirmed. Your verification receipt is ready.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not verify payment.';
      if (pendingForAttempt) {
        setPending(pendingForAttempt);
        setStatus(`${pendingPersistenceFailedForAttempt ? 'Recovery storage could not be saved. Keep this screen open and share the transaction hash. ' : ''}Payment submitted. Retry verification; do not pay again. ${message}`);
        Alert.alert('Payment submitted', 'Retry verification for the existing transaction. Do not pay again.');
      } else {
        setStatus(message);
        Alert.alert('Payment not completed', message);
      }
    } finally {
      setBusy(false);
    }
  };

  const connected = Boolean(getWalletSession());
  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Pressable onPress={onBack} accessibilityRole="button" style={styles.back}><Text style={styles.backText}>‹</Text></Pressable>
        <View style={styles.headerCopy}><Text style={styles.title}>Blue Star verification</Text><Text style={styles.subtitle}>{subjectName}</Text></View>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        {alreadyVerified && !receipt ? (
          <View style={styles.card}>
            <Text style={styles.successTitle}>★ Blue Star already active</Text>
            <Text style={styles.description}>{status}</Text>
            <Pressable style={styles.payButton} onPress={onBack}><Text style={styles.payText}>Done</Text></Pressable>
          </View>
        ) : !receipt ? (
          <View style={styles.card}>
            <Text style={styles.description}>Choose a plan. Your wallet will ask you to approve the USDC payment.</Text>
            <Text style={styles.label}>Plan</Text>
            <View style={styles.options}>{PLANS.map(item => <Pressable key={item} disabled={busy || Boolean(pending)} onPress={() => setPlan(item)} style={[styles.option, plan === item && styles.optionActive, Boolean(pending) && styles.optionDisabled]}><Text style={[styles.optionText, plan === item && styles.optionTextActive]}>{item === 'annual' ? '$5 USDC / year' : '$1 USDC / month'}</Text></Pressable>)}</View>
            <Text style={styles.label}>Network</Text>
            <View style={styles.options}>{CHAINS.map(item => <Pressable key={item} disabled={busy || Boolean(pending)} onPress={() => setChain(item)} style={[styles.option, chain === item && styles.optionActive, Boolean(pending) && styles.optionDisabled]}><Text style={[styles.optionText, chain === item && styles.optionTextActive]}>{item === 'ethereum' ? 'Ethereum' : item === 'arbitrum' ? 'Arbitrum' : item[0].toUpperCase() + item.slice(1)}</Text></Pressable>)}</View>
            <View style={styles.walletState}><View style={styles.dot}/><Text style={styles.walletText}>{connected ? 'Kivo wallet connected' : 'Unlock Kivo wallet to continue'}</Text></View>
            <Pressable disabled={busy || !pendingLoaded || !connected || !socialReady} onPress={() => void pay()} style={[styles.payButton, (busy || !pendingLoaded || !connected || !socialReady) && styles.buttonDisabled]}>
              {busy ? <ActivityIndicator color={kivoTheme.colors.backgroundDeep}/> : <Text style={styles.payText}>{pending ? 'Retry verification' : `Pay ${plan === 'annual' ? '$5' : '$1'} USDC`}</Text>}
            </Pressable>
            <Text style={styles.status} accessibilityLiveRegion="polite">{status}</Text>
            {pending ? <Pressable style={styles.secondaryButton} onPress={() => Share.share({ message: `Kivo Blue Star payment recovery\\nSubject: ${subjectType} ${subjectId}\\nNetwork: ${pending.chain}\\nPlan: ${pending.plan}\\nTransaction: ${pending.txHash}\\nRetry verification in Kivo; do not pay again.` })}><Text style={styles.secondaryText}>Share transaction recovery details</Text></Pressable> : null}
            <Text style={styles.finePrint}>No funds move until you approve the transaction in your wallet.</Text>
          </View>
        ) : (
          <View style={styles.card}>
            <Text style={styles.successTitle}>★ Blue Star activated</Text>
            <Text style={styles.description}>Your payment is confirmed and your badge is active.</Text>
            <ReceiptRow label="Subject" value={subjectName}/>
            <ReceiptRow label="Plan" value={`${receipt.plan === 'annual' ? 'Annual' : 'Monthly'} · ${receipt.amount} USDC`}/>
            <ReceiptRow label="Network" value={receipt.chain}/>
            <ReceiptRow label="Transaction" value={receipt.txHash}/>
            <ReceiptRow label="Paid" value={new Date(receipt.paidAt).toLocaleString()}/>
            <ReceiptRow label="Valid until" value={new Date(receipt.expiresAt).toLocaleDateString()}/>
            <Pressable style={styles.secondaryButton} onPress={() => Share.share({ message: `Kivo Blue Star receipt\nStatus: Paid & Verified\nPlan: ${receipt.plan}\nAmount: ${receipt.amount} USDC\nNetwork: ${receipt.chain}\nTransaction: ${receipt.txHash}\nExplorer: ${receipt.explorerUrl}` })}><Text style={styles.secondaryText}>Share receipt</Text></Pressable>
            <Pressable style={styles.secondaryButton} onPress={() => Share.share({ message: receipt.explorerUrl })}><Text style={styles.secondaryText}>View transaction</Text></Pressable>
            <Pressable style={styles.payButton} onPress={onBack}><Text style={styles.payText}>Done</Text></Pressable>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function ReceiptRow({ label, value }: { label: string; value: string }) {
  return <View style={styles.receiptRow}><Text style={styles.receiptLabel}>{label}</Text><Text selectable style={styles.receiptValue}>{value}</Text></View>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: kivoTheme.colors.background },
  header: { minHeight: 68, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, borderBottomWidth: 1, borderBottomColor: kivoTheme.colors.border, backgroundColor: kivoTheme.colors.backgroundDeep },
  back: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: kivoTheme.colors.surface, marginRight: 12 },
  backText: { color: kivoTheme.colors.text, fontSize: 28, lineHeight: 30 },
  headerCopy: { flex: 1, gap: 2 },
  title: { color: kivoTheme.colors.text, fontSize: 20, fontWeight: '800' },
  subtitle: { color: kivoTheme.colors.textMuted, fontSize: 13 },
  content: { padding: 18, paddingBottom: 32, gap: 12 },
  card: { padding: 18, borderRadius: 18, borderWidth: 1, borderColor: kivoTheme.colors.border, backgroundColor: kivoTheme.colors.surface, gap: 12 },
  description: { color: kivoTheme.colors.textMuted, fontSize: 14, lineHeight: 21 },
  label: { color: kivoTheme.colors.text, fontSize: 13, fontWeight: '800', marginTop: 4 },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  option: { borderWidth: 1, borderColor: kivoTheme.colors.border, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 11, backgroundColor: kivoTheme.colors.backgroundDeep },
  optionActive: { borderColor: kivoTheme.colors.accent, backgroundColor: kivoTheme.colors.accent },
  optionDisabled: { opacity: 0.6 },
  optionText: { color: kivoTheme.colors.text, fontSize: 13, fontWeight: '700' },
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
