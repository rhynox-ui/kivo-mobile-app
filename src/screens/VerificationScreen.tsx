import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, Linking, Modal, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { api, storage, useSocialReady } from '../state/session';
import { getWalletSession, localEvmSigner, withDeviceAccounts } from '../state/walletStore';
import { encodeFunctionData, parseUnits } from 'viem';
import { Buffer } from 'buffer';
import { kivoUserIdForWallet, verificationPaymentMemo } from '../../shared/api/types';
import { getViemChain, publicClientForChainId } from '@kivo/trading/core/chainRegistry';
import { sendEvmCallsViaRelayGasless } from '@kivo/trading/core/relayGaslessEvm';
import { signAndSendSponsoredSolanaStep, type SolanaTransactionSigner } from '@kivo/trading/core/executeRelayQuote';
import { Connection, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import * as Keychain from 'react-native-keychain';
import { createAssociatedTokenAccountInstruction, createTransferCheckedInstruction, getAssociatedTokenAddress } from '@solana/spl-token';
import { kivoTheme } from '../theme/kivoTheme';
import Svg, { Path, Polygon, Circle } from 'react-native-svg';
import { KivoModal } from '../components/KivoModal';
import { UsdcLogo } from '../components/TokenIcon';

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
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

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

type Stage = 'loading' | 'form' | 'wallet' | 'confirming' | 'failed' | 'active';
const EXPECTED_SECONDS: Record<Chain, number> = { base: 45, arbitrum: 10, ethereum: 150, solana: 20 };
const VERIFY_DEADLINE_MS = 20 * 60_000;
const CHAIN_IDS = { ethereum: 1, base: 8453, arbitrum: 42161 } as const;
const EVM_USDC = { ethereum: '0xA0b86991c6218b36c1d19d4a2e9Eb0cE3606eB48', base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', arbitrum: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' } as const;
// Solana's own public RPC often refuses requests; use the first endpoint that answers.
const SOLANA_RPCS = ['https://rpc.solanatracker.io/public', 'https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com'];
async function workingSolanaConnection(): Promise<Connection> {
  for (const url of SOLANA_RPCS) {
    const connection = new Connection(url, 'confirmed');
    try { await connection.getLatestBlockhash('confirmed'); return connection; } catch { /* try the next endpoint */ }
  }
  throw new Error('Could not reach the Solana network. Try again in a moment; nothing was sent.');
}
const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

function explorerTx(chain: Chain, hash: string): string {
  return chain === 'solana' ? `https://solscan.io/tx/${hash}` : chain === 'base' ? `https://basescan.org/tx/${hash}` : chain === 'arbitrum' ? `https://arbiscan.io/tx/${hash}` : `https://etherscan.io/tx/${hash}`;
}
const shortHash = (hash: string) => `${hash.slice(0, 6)}…${hash.slice(-4)}`;
const httpStatusOf = (error: unknown) => (typeof error === 'object' && error !== null && 'status' in error ? Number((error as { status?: unknown }).status) || 0 : 0);

/**
 * Blue Star checkout: one card, one state at a time —
 * form → confirm in wallet → payment sent (live confirmations) → verified.
 * Server polling starts as soon as the transaction hash exists and is
 * idempotent per hash, so it can never charge or extend twice.
 */
export function VerificationScreen({ subjectType, subjectId, subjectName, onBack }: {
  subjectType: SubjectType;
  subjectId: string;
  subjectName: string;
  onBack: () => void;
}) {
  const socialReady = useSocialReady();
  const [stage, setStage] = useState<Stage>('loading');
  const [plan, setPlan] = useState<Plan>('monthly');
  const [chain, setChain] = useState<Chain>('base');
  const [networkPickerOpen, setNetworkPickerOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingPayment | null>(null);
  const [failure, setFailure] = useState<{ message: string; pending: PendingPayment | null } | null>(null);
  const [confirmations, setConfirmations] = useState<{ have: number; need: number } | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [receipt, setReceipt] = useState<any>(null);
  const [showReceipt, setShowReceipt] = useState(false);
  const [activeUntil, setActiveUntil] = useState<number | null>(null);
  const [permanent, setPermanent] = useState(false);
  const [celebrate, setCelebrate] = useState(false);
  const verifyingRef = useRef(false);
  const payingRef = useRef(false);
  const mountedRef = useRef(true);
  const receiptStorageKey = `kivo:verification-receipt:${subjectType}:${subjectId}`;
  const storageKey = `kivo:verification-pending:${subjectType}:${subjectId}`;
  const keychainService = `${PENDING_KEYCHAIN_SERVICE}.${subjectType}.${encodeURIComponent(subjectId)}`;

  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

  const loadPending = async (): Promise<PendingPayment | null> => {
    const raw = await readPendingRecord(storageKey, keychainService).catch(() => null);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingPayment;
    return { txHash: parsed.txHash, chain: parsed.chain, plan: parsed.plan };
  };

  /** Polls the server until it credits this exact payment, or gives a final answer. Never sends a payment. */
  const verify = async (current: PendingPayment) => {
    if (verifyingRef.current) return;
    verifyingRef.current = true;
    const began = Date.now();
    setPending(current); setPlan(current.plan); setChain(current.chain);
    setConfirmations(null); setStartedAt(began); setStage('confirming');
    let failedOnChain = false;
    // Spot an EVM revert right away, in parallel; never block on a slow public RPC.
    if (current.chain !== 'solana') {
      try {
        void publicClientForChainId(CHAIN_IDS[current.chain]).waitForTransactionReceipt({ hash: current.txHash as `0x${string}`, timeout: 120_000 })
          .then(receipt => { if (receipt.status !== 'success') failedOnChain = true; }).catch(() => {});
      } catch { /* no RPC for this chain: the server check still decides */ }
    }
    try {
      for (let attempt = 0; mountedRef.current; attempt++) {
        if (failedOnChain) {
          await clearPendingRecord(storageKey, keychainService);
          if (!mountedRef.current) return;
          setPending(null);
          setFailure({ message: 'The payment transaction failed on-chain, so no USDC was transferred. You can try again.', pending: null });
          setStage('failed');
          return;
        }
        try {
          const result = await api.purchaseVerification({ subjectType, subjectId, plan: current.plan, chain: current.chain, txHash: current.txHash });
          // Show the new Blue Star everywhere right away instead of after the cache minute.
          api.forgetVerification(subjectType, subjectId);
          await clearPendingRecord(storageKey, keychainService);
          await Promise.resolve(storage.setItem(receiptStorageKey, JSON.stringify(result))).catch(() => {});
          if (!mountedRef.current) return;
          setPending(null);
          setReceipt(result);
          setActiveUntil(result.expiresAt);
          setCelebrate(true);
          setStage('active');
          return;
        } catch (error) {
          const status = httpStatusOf(error);
          const message = error instanceof Error ? error.message : '';
          const progress = /\((\d+)\/(\d+)\)/.exec(message);
          if (progress && mountedRef.current) setConfirmations({ have: Number(progress[1]), need: Number(progress[2]) });
          const network = !status && /network|fetch|timed? ?out|request failed/i.test(message);
          const retryable = status === 409 || status === 429 || network || (status >= 500 && status <= 599);
          if (!retryable) {
            // 400 is a final answer about this hash. 403 depends on which account is
            // signed in (e.g. after a wallet switch), so keep the saved payment and
            // offer "Check again" for the right account.
            const final = status === 400;
            if (final) await clearPendingRecord(storageKey, keychainService);
            if (!mountedRef.current) return;
            setFailure({ message: message || 'Kivo could not verify this payment.', pending: final ? null : current });
            setStage('failed');
            return;
          }
          if (Date.now() - began > VERIFY_DEADLINE_MS) {
            if (!mountedRef.current) return;
            setFailure({ message: 'This is taking longer than usual. Your payment is safe on-chain; Kivo finishes verifying when you check again.', pending: current });
            setStage('failed');
            return;
          }
          await new Promise<void>(resolve => setTimeout(resolve, status === 429 ? 65_000 : Math.min(15_000, 3_000 + attempt * 2_000)));
        }
      }
    } finally {
      verifyingRef.current = false;
    }
  };

  // First view from server truth; a saved payment resumes verifying at once.
  useEffect(() => {
    let active = true;
    void Promise.resolve(storage.getItem(receiptStorageKey)).then(raw => { if (active && raw) { try { setReceipt(JSON.parse(raw)); } catch {} } }).catch(() => {});
    void (async () => {
      const saved = await loadPending();
      if (!active) return;
      if (saved) { void verify(saved); return; }
      try {
        const current = await api.verificationStatus(subjectType, subjectId);
        if (!active) return;
        setPermanent(Boolean(current.permanent));
        if (current.isVerified) {
          setActiveUntil(current.expiresAt ?? null);
          setStage('active');
          void api.latestVerificationReceipt(subjectType, subjectId).then(r => { if (active && r) setReceipt(r); }).catch(() => {});
        } else {
          setStage('form');
        }
      } catch {
        if (active) { setNote('Could not load verification status. You can still pay; Kivo verifies on-chain.'); setStage('form'); }
      }
    })();
    return () => { active = false; };
  }, [subjectType, subjectId]);

  // Coming back to the app resumes a saved payment.
  useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      if (state !== 'active' || verifyingRef.current) return;
      void loadPending().then(saved => { if (saved) void verify(saved); });
    });
    return () => sub.remove();
  }, [storageKey]);

  // Elapsed-time ticker while confirming.
  useEffect(() => {
    if (stage !== 'confirming') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [stage]);

  const pay = async () => {
    // Synchronous guard: a double tap must never start two payments.
    if (payingRef.current || verifyingRef.current) return;
    payingRef.current = true;
    try { await payOnce(); } finally { payingRef.current = false; }
  };
  const payOnce = async () => {
    setNote(null);
    if (!socialReady) { setNote('Turn on chats first so your Kivo account can be verified.'); return; }
    const session = getWalletSession();
    if (!session) { setNote('Unlock your Kivo wallet before paying.'); return; }
    const buyer = kivoUserIdForWallet(session.address);
    setStage('wallet');
    let txHash: string;
    try {
      if (chain === 'solana') {
        txHash = await withDeviceAccounts('Approve Blue Star USDC payment', async ({ solana }) => {
          const connection = await workingSolanaConnection();
          const mint = new PublicKey(USDC_MINT);
          const recipient = new PublicKey(SOLANA_RECIPIENT);
          const sourceAta = await getAssociatedTokenAddress(mint, solana.publicKey);
          const priceRaw = plan === 'annual' ? 5_000_000n : 1_000_000n;
          const usdc = await connection.getTokenAccountBalance(sourceAta).then(r => BigInt(r.value.amount)).catch(() => 0n);
          if (usdc < priceRaw) throw new Error(`Your Kivo wallet has ${(Number(usdc) / 1e6).toFixed(2)} USDC on Solana; ${plan === 'annual' ? 5 : 1} USDC is needed. Nothing was sent.`);
          const destinationAta = await getAssociatedTokenAddress(mint, recipient);
          const instructions: TransactionInstruction[] = [];
          if (!(await connection.getAccountInfo(destinationAta))) instructions.push(createAssociatedTokenAccountInstruction(solana.publicKey, destinationAta, recipient, mint));
          instructions.push(createTransferCheckedInstruction(sourceAta, mint, destinationAta, solana.publicKey, priceRaw, 6));
          // Binds the payment to this Kivo account and subject; the server rejects Solana payments without it.
          instructions.push(new TransactionInstruction({ programId: new PublicKey(MEMO_PROGRAM_ID), keys: [{ pubkey: solana.publicKey, isSigner: true, isWritable: false }], data: Buffer.from(verificationPaymentMemo(buyer, subjectType, subjectId), 'utf8') }));
          // No SOL for the network fee: Kivo's fee sponsor pays it (same sponsor as trades and withdrawals).
          if ((await connection.getBalance(solana.publicKey)) < 20_000) {
            const signer: SolanaTransactionSigner = { publicKey: solana.publicKey, async sign(versioned) { versioned.sign([solana]); return versioned; } };
            const sponsored = await signAndSendSponsoredSolanaStep(instructions, [], signer, connection, { spend: USDC_MINT, maxSpend: priceRaw });
            return sponsored.signature;
          }
          const transaction = new Transaction();
          transaction.add(...instructions);
          const { blockhash } = await connection.getLatestBlockhash('confirmed');
          transaction.feePayer = solana.publicKey;
          transaction.recentBlockhash = blockhash;
          return connection.sendTransaction(transaction, [solana], { skipPreflight: false, preflightCommitment: 'confirmed' });
        });
      } else {
        const data = encodeFunctionData({
          abi: [{ type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }], outputs: [{ type: 'bool' }] }],
          functionName: 'transfer',
          args: [EVM_RECIPIENT, parseUnits(plan === 'annual' ? '5' : '1', 6)],
        });
        // Gas is sponsored through Relay (same as withdrawals), so no ETH is needed.
        // The server credits the USDC Transfer log from this wallet to Kivo, whoever paid the gas.
        let sponsoredHash: string | null = null;
        try {
          sponsoredHash = await withDeviceAccounts('Approve Blue Star USDC payment', async ({ evm }) => {
            if (evm.address.toLowerCase() !== session.address.toLowerCase()) throw new Error('The unlocked wallet does not match your Kivo account. Nothing was sent.');
            const result = await sendEvmCallsViaRelayGasless({ chain: getViemChain(chain), fromAddress: evm.address, account: evm, calls: [{ to: EVM_USDC[chain], value: 0n, data }] });
            if (!/^0x[0-9a-fA-F]{64}$/.test(result.hash)) throw new Error('Your payment was submitted but its transaction id is not available yet. Do not pay again — check your Blue Star status in a few minutes.');
            return result.hash;
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : '';
          // Only fall back to paying gas yourself when sponsorship is unavailable before anything was sent.
          if (!/not switched on|not configured|not available on this network|Calibur/i.test(message)) throw error;
        }
        if (sponsoredHash) {
          txHash = sponsoredHash;
        } else {
          const signer = await localEvmSigner();
          if (signer.address.toLowerCase() !== session.address.toLowerCase()) throw new Error('The unlocked wallet does not match your Kivo account. Nothing was sent.');
          await signer.ensureChain(CHAIN_IDS[chain]);
          txHash = await signer.sendTransaction({ to: EVM_USDC[chain], data, value: 0n, chainId: CHAIN_IDS[chain] });
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Payment was not sent.';
      if (!mountedRef.current) return;
      setNote(/cancel|denied|reject|locked/i.test(message) ? 'Payment cancelled. Nothing was sent.' : message);
      setStage('form');
      return;
    }
    const sent: PendingPayment = { txHash, chain, plan };
    const saved = await savePendingRecord(storageKey, keychainService, JSON.stringify(sent));
    if (!saved) setNote('Recovery storage is unavailable — keep this screen open until verification finishes.');
    await verify(sent);
  };

  const elapsed = Math.max(0, Math.round((now - startedAt) / 1000));
  const elapsedLabel = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
  const progressRatio = confirmations ? confirmations.have / confirmations.need : Math.min(0.9, elapsed / EXPECTED_SECONDS[chain]);
  const openTx = (p: PendingPayment) => Linking.openURL(explorerTx(p.chain, p.txHash)).catch(() => Alert.alert('Kivo', 'Could not open the block explorer.'));
  const receiptPayer = receipt?.payer ?? receipt?.payer_address ?? 'Shown on verified payment record';
  const connected = Boolean(getWalletSession());

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Pressable onPress={onBack} accessibilityRole="button" style={styles.back}><Text style={styles.backText}>‹</Text></Pressable>
        <View style={styles.headerCopy}><Text style={styles.title}>Blue Star</Text><Text style={styles.subtitle}>{subjectName}</Text></View>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        {stage === 'loading' ? (
          <View style={[styles.card, styles.stateCard]}><ActivityIndicator color={kivoTheme.colors.accent} /><Text style={styles.description}>Checking verification status…</Text></View>
        ) : stage === 'wallet' ? (
          <View style={[styles.card, styles.stateCard]}>
            <ActivityIndicator size="large" color={kivoTheme.colors.accent} />
            <Text style={styles.stateTitle}>Confirm in your Kivo wallet</Text>
            <Text style={styles.stateText}>Approve {plan === 'annual' ? '5' : '1'} USDC on {CHAIN_META[chain].label}. Nothing is sent until you approve.</Text>
          </View>
        ) : stage === 'confirming' && pending ? (
          <View style={[styles.card, styles.stateCard]}>
            <View style={[styles.stateBadge, styles.badgeSent]}><Text style={styles.badgeSentText}>↗</Text></View>
            <Text style={styles.stateTitle}>Payment sent</Text>
            <Pressable onPress={() => openTx(pending)} accessibilityRole="link"><Text style={styles.txLink}>{shortHash(pending.txHash)} ↗</Text></Pressable>
            <View style={styles.bar} accessibilityRole="progressbar"><View style={[styles.barFill, { width: `${Math.max(6, Math.min(100, Math.round(progressRatio * 100)))}%` }]} /></View>
            <View style={styles.barMeta}><Text style={styles.barLabel}>Confirming on {CHAIN_META[pending.chain].label}{confirmations ? ` · ${confirmations.have}/${confirmations.need}` : '…'}</Text><Text style={styles.barTime}>{elapsedLabel}</Text></View>
            <Text style={styles.stateText}>Kivo activates your badge automatically. You can leave this screen — it finishes when you come back. Don't pay again.</Text>
            {note ? <Text style={styles.noteText}>{note}</Text> : null}
          </View>
        ) : stage === 'failed' && failure ? (
          <View style={[styles.card, styles.stateCard]}>
            <View style={[styles.stateBadge, styles.badgeFailed]}><Text style={styles.badgeFailedText}>!</Text></View>
            <Text style={styles.stateTitle}>{failure.pending ? 'Still verifying' : 'Payment not completed'}</Text>
            <Text style={styles.stateText}>{failure.message}</Text>
            {failure.pending ? <Pressable onPress={() => openTx(failure.pending!)}><Text style={styles.txLink}>{shortHash(failure.pending.txHash)} ↗</Text></Pressable> : null}
            {failure.pending
              ? <Pressable style={[styles.payButton, styles.fullWidth]} onPress={() => void verify(failure.pending!)}><Text style={styles.payText}>Check again</Text></Pressable>
              : <Pressable style={[styles.payButton, styles.fullWidth]} onPress={() => { setFailure(null); setStage('form'); }}><Text style={styles.payText}>Try again</Text></Pressable>}
            {failure.pending ? <Pressable style={[styles.secondaryButton, styles.fullWidth]} onPress={() => Share.share({ message: `Kivo Blue Star payment\nSubject: ${subjectType} ${subjectId}\nNetwork: ${failure.pending!.chain}\nPlan: ${failure.pending!.plan}\nTransaction: ${failure.pending!.txHash}\nDo not pay again.` })}><Text style={styles.secondaryText}>Share transaction details</Text></Pressable> : null}
          </View>
        ) : stage === 'active' ? (
          <View style={[styles.card, styles.stateCard]}>
            <View style={styles.starBadge}><Text style={styles.starBadgeText}>★</Text></View>
            <Text style={styles.stateTitle}>{celebrate ? "You're verified" : 'Blue Star active'}</Text>
            <Text style={styles.stateText}>{permanent ? 'Permanently verified.' : activeUntil ? `Active until ${new Date(activeUntil).toLocaleDateString()}.` : 'Active.'}</Text>
            <Pressable style={[styles.payButton, styles.fullWidth]} onPress={onBack}><Text style={styles.payText}>Done</Text></Pressable>
            <View style={styles.rowButtons}>
              {receipt ? <Pressable style={[styles.secondaryButton, styles.flex1]} onPress={() => setShowReceipt(v => !v)}><Text style={styles.secondaryText}>{showReceipt ? 'Hide receipt' : 'Receipt'}</Text></Pressable> : null}
              {permanent ? null : <Pressable style={[styles.secondaryButton, styles.flex1]} onPress={() => { setCelebrate(false); setShowReceipt(false); setNote(null); setStage('form'); }}><Text style={styles.secondaryText}>Extend</Text></Pressable>}
            </View>
            {showReceipt && receipt ? (
              <View style={styles.receiptBox}>
                <ReceiptRow label="Subject" value={subjectName}/>
                <ReceiptRow label="Plan" value={`${receipt.plan === 'annual' ? 'Annual' : 'Monthly'} · ${receipt.amount} USDC`}/>
                <ReceiptRow label="Network" value={String(receipt.chain)}/>
                <ReceiptRow label="Transaction" value={receipt.txHash}/>
                <ReceiptRow label="Payer" value={receiptPayer}/>
                <View style={styles.qrWrap}><QRCode value={receipt.explorerUrl || receipt.txHash} size={128} backgroundColor="#FFFFFF" color="#062F2C"/><Text style={styles.qrCaption}>Scan to view transaction</Text></View>
                <ReceiptRow label="Paid" value={new Date(receipt.paidAt).toLocaleString()}/>
                <ReceiptRow label="Valid until" value={new Date(receipt.expiresAt).toLocaleDateString()}/>
                <Pressable style={styles.secondaryButton} onPress={() => Share.share({ message: `Kivo Blue Star receipt\nSubject: ${subjectType} — ${subjectName}\nPlan: ${receipt.plan === 'annual' ? 'Annual (365 days)' : 'Monthly (30 days)'}\nAmount: ${receipt.amount} USDC\nNetwork: ${receipt.chain}\nTransaction: ${receipt.txHash}\nPayer: ${receiptPayer}\nPaid: ${new Date(receipt.paidAt).toLocaleString()}\nValid until: ${new Date(receipt.expiresAt).toLocaleString()}\nExplorer: ${receipt.explorerUrl}` })}><Text style={styles.secondaryText}>Share receipt</Text></Pressable>
              </View>
            ) : null}
          </View>
        ) : (
          <View style={styles.card}>
            <Text style={styles.stateTitleLeft}>{activeUntil ? 'Extend Blue Star' : 'Get the Blue Star'}</Text>
            <Text style={styles.description}>{activeUntil ? `Active until ${new Date(activeUntil).toLocaleDateString()}. Extending adds time to the end.` : `A verified badge and square avatar on your ${subjectType === 'channel' ? 'channel' : 'profile'}. Paid in USDC from your Kivo wallet.`}</Text>
            <Text style={styles.label}>Plan</Text>
            <View style={styles.options}>{PLANS.map(item => <Pressable key={item} onPress={() => setPlan(item)} style={[styles.option, plan === item && styles.optionActive]}><UsdcLogo /><View style={styles.planCopy}><Text style={[styles.optionText, plan === item && styles.optionTextActive]}>{item === 'annual' ? '$5 USDC / year' : '$1 USDC / month'}</Text><Text style={[styles.planHint, plan === item && styles.optionTextActive]}>{item === 'annual' ? '365 days · Best value' : '30 days'}</Text></View>{plan === item ? <Text style={styles.planSelected}>✓</Text> : <View style={styles.planRadio} />}</Pressable>)}</View>
            <Text style={styles.label}>Pay on</Text>
            <Pressable accessibilityRole="button" accessibilityLabel={`Choose network. Selected: ${CHAIN_META[chain].label}`} onPress={() => setNetworkPickerOpen(true)} style={styles.networkSelector}>
              <NetworkLogo chain={chain} />
              <View style={styles.networkCopy}><Text style={styles.networkName}>{CHAIN_META[chain].label}</Text><Text style={styles.networkSubtitle}>{CHAIN_META[chain].subtitle}</Text></View>
              <Text style={styles.networkChevron}>⌄</Text>
            </Pressable>
            <KivoModal visible={networkPickerOpen} transparent animationType="fade" onRequestClose={() => setNetworkPickerOpen(false)}>
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
            </KivoModal>
            <View style={styles.walletState}><View style={styles.dot}/><Text style={styles.walletText}>{connected ? 'Kivo wallet ready' : 'Unlock your Kivo wallet to continue'}</Text></View>
            <Pressable disabled={!connected || !socialReady} onPress={() => setConfirmOpen(true)} style={[styles.payButton, (!connected || !socialReady) && styles.buttonDisabled]}>
              <Text style={styles.payText}>Pay {plan === 'annual' ? '5' : '1'} USDC on {CHAIN_META[chain].label}</Text>
            </Pressable>
            {note ? <Text style={styles.noteText}>{note}</Text> : <Text style={styles.finePrint}>Kivo verifies the payment on-chain and activates your badge automatically.</Text>}
            {activeUntil ? <Pressable style={styles.secondaryButton} onPress={() => setStage('active')}><Text style={styles.secondaryText}>Back</Text></Pressable> : null}
          </View>
        )}
        <KivoModal visible={confirmOpen} transparent animationType="fade" onRequestClose={() => setConfirmOpen(false)}>
          <View style={styles.confirmBackdrop}>
            <View style={styles.confirmCard}>
              <Text style={styles.stateTitleLeft}>Confirm payment</Text>
              <Text style={styles.description}><Text style={styles.strong}>{plan === 'annual' ? '$5 USDC · 365 days' : '$1 USDC · 30 days'}</Text> on {CHAIN_META[chain].label}</Text>
              <Text style={styles.description}>You approve it in your Kivo wallet. No funds move until you do.</Text>
              <View style={styles.confirmActions}>
                <Pressable style={[styles.secondaryButton, styles.flex1]} onPress={() => setConfirmOpen(false)}><Text style={styles.secondaryText}>Cancel</Text></Pressable>
                <Pressable style={[styles.payButton, styles.flex1]} onPress={() => { setConfirmOpen(false); void pay(); }}><Text style={styles.payText}>Continue</Text></Pressable>
              </View>
            </View>
          </View>
        </KivoModal>
      </ScrollView>
    </View>
  );
}

function ReceiptRow({ label, value }: { label: string; value: string }) {
  return <View style={styles.receiptRow}><Text style={styles.receiptLabel}>{label}</Text><Text selectable style={styles.receiptValue}>{value}</Text></View>;
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
  stateCard: { alignItems: 'center', paddingVertical: 22, paddingHorizontal: 14, gap: 12 },
  stateTitle: { color: kivoTheme.colors.text, fontSize: 20, fontWeight: '900', textAlign: 'center' },
  stateTitleLeft: { color: kivoTheme.colors.text, fontSize: 17, fontWeight: '900' },
  stateText: { color: kivoTheme.colors.textMuted, fontSize: 13, lineHeight: 19, textAlign: 'center' },
  stateBadge: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center' },
  badgeSent: { backgroundColor: 'rgba(37,137,245,0.16)' },
  badgeSentText: { color: '#2589F5', fontSize: 28, fontWeight: '900' },
  badgeFailed: { backgroundColor: 'rgba(255,125,125,0.14)' },
  badgeFailedText: { color: kivoTheme.colors.danger, fontSize: 30, fontWeight: '900' },
  starBadge: { width: 76, height: 76, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: '#2589F5' },
  starBadgeText: { color: '#FFFFFF', fontSize: 40, fontWeight: '900' },
  txLink: { color: kivoTheme.colors.accent, fontSize: 14, fontWeight: '700', fontFamily: 'monospace' },
  bar: { width: '100%', height: 10, borderRadius: 999, backgroundColor: 'rgba(244,240,199,0.1)', overflow: 'hidden' },
  barFill: { height: '100%', borderRadius: 999, backgroundColor: '#2589F5' },
  barMeta: { width: '100%', flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  barLabel: { color: kivoTheme.colors.text, fontSize: 12, fontWeight: '700', flexShrink: 1 },
  barTime: { color: kivoTheme.colors.textMuted, fontSize: 12 },
  noteText: { color: kivoTheme.colors.cream, fontSize: 12, lineHeight: 18 },
  fullWidth: { alignSelf: 'stretch' },
  flex1: { flex: 1 },
  rowButtons: { flexDirection: 'row', gap: 8, alignSelf: 'stretch' },
  receiptBox: { alignSelf: 'stretch', gap: 4, marginTop: 4 },
  strong: { color: kivoTheme.colors.text, fontWeight: '800' },
});
