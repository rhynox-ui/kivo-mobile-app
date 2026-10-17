import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Image, Linking, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { kivoTheme } from '../theme/kivoTheme';
import { CHAIN_LABEL, tradeChainLabel, type ChainKey, type TradeChain } from '@kivo/trading/core/chainData';
import { NetworkIcon } from '../wallet/NetworkIcon';
import { TRADE_CHAIN_ORDER } from './SearchScreen';
import { fetchCashBalances, totalCashUsd, readTokenBalance, type CashBalanceRow, type TokenBalance } from '@kivo/trading/kivo/balances';
import { planUnifiedBuy, totalSpendableCash, type UnifiedPlan } from '@kivo/trading/kivo/unified';
import { executeDirectPlan, planDirectTrade } from '@kivo/trading/kivo/direct';
import { transactionLink, KivoExecutionError, preflightKivoQuote, relayRequestUrl, type ExecutionUpdate } from '@kivo/trading/kivo/execute';
import { loadGaslessTradingEnabled } from '../settings/gaslessTradingPrefs';
import { executeRelayQuote, getPartialTxHashes } from '@kivo/trading/core/executeRelayQuote';
import { quoteSponsorshipStatus } from '@kivo/trading/core/relayQuote';
import { haptic } from '../utils/haptics';
import bs58 from 'bs58';
import { recordTrade } from '@kivo/trading/kivo/history';
import { markOwnAction } from '../wallet/depositWatcher';
import { describeQuoteError, isQuoteExpired, parseAmountInput, requestKivoQuote, sellProceedsAsset } from '@kivo/trading/kivo/quote';
import { chainLabel, formatAmount, formatUsd, shortAddress, tradeSupportFor, type KivoToken, type TradeSide } from '@kivo/trading/kivo/tokens';
import { getWalletSession, subscribeToWallet, walletKind, withDeviceAccounts, type WalletSession } from '../state/walletStore';
import { addNotification } from '../state/notificationStore';
import { updateSettings, useSettings } from '../state/settingsStore';
import { TokenChartPanel } from '../components/TokenChartPanel';
import { MAINNET_CHAIN_IDS } from '@kivo/trading/core/chainData';
import { MIN_TRADE_USD } from '@kivo/trading/core/fees';
import { checkSolanaTokenSecurity, checkTokenSecurity } from '@kivo/trading/core/goplusTokenSecurity';
import { NearTradePanel } from './NearTradePanel';
import { normalizeAmountInput } from '../utils/amountInput';
import { KivoModal } from '../components/KivoModal';
import Clipboard from '@react-native-clipboard/clipboard';

type QuoteState = 'idle' | 'loading' | 'ready' | 'error';
type ExecResult = { tone: 'success' | 'pending' | 'error'; message: string; hashes: string[]; chainIds: number[]; requestId: string | null; receipt?: { paid: string; received: string; feesUsd: number | null } };

// Gasless (Mango Pro model): one signature on the device, Relay submits and pays gas.
const STAGES: Array<[ExecutionUpdate['stage'][], string]> = [
  [['preflight'], 'Safety check'],
  [['switching-network', 'awaiting-signature', 'confirming'], 'Sign on this device'],
  [['filling', 'success', 'pending', 'refunded'], 'Relay submits · Kivo pays gas'],
];

export function TradeScreen({ onToken, onPickChain, onShareToFeed, selectedToken, initialSide = 'buy', onOpenHistory }: {
  onToken?: () => void;
  /** Open the feed composer with the traded token attached and a drafted post. */
  onShareToFeed?: (draft: { chain: string; address: string; text: string }) => void;
  /** Open token discovery filtered to one network (the "Trading on" picker). */
  onPickChain?: (chain: TradeChain) => void;
  selectedToken?: KivoToken | null;
  initialSide?: TradeSide;
  onOpenHistory?: () => void;
}) {
  const [side, setSide] = useState<TradeSide>(initialSide);
  const [amount, setAmount] = useState('');
  const [wallet, setWallet] = useState<WalletSession | null>(getWalletSession());
  const [cash, setCash] = useState<CashBalanceRow[] | null>(null);
  const [tokenBalance, setTokenBalance] = useState<TokenBalance | null>(null);
  const tokenDecimals = tokenBalance?.decimals ?? 18;
  const [balanceError, setBalanceError] = useState('');
  // Buy: a unified-cash plan (one or more legs). Sell: a single-leg plan.
  const [plan, setQuote] = useState<UnifiedPlan | null>(null);
  const [quoteState, setQuoteState] = useState<QuoteState>('idle');
  const [quoteError, setQuoteError] = useState('');
  const [now, setNow] = useState(Date.now());
  const [reviewOpen, setReviewOpen] = useState(false);
  const [update, setUpdate] = useState<ExecutionUpdate | null>(null);
  const [result, setResult] = useState<ExecResult | null>(null);
  // One haptic per trade outcome (respects the Haptics setting).
  useEffect(() => { if (result) haptic(result.tone === 'success' ? 'success' : result.tone === 'error' ? 'error' : 'warning'); }, [result]);
  const [running, setRunning] = useState(false);
  const executingRef = useRef(false);
  const [chainOpen, setChainOpen] = useState(false);
  const [networkOpen, setNetworkOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draftSlippage, setDraftSlippage] = useState<number | null>(null);
  const [customSlippage, setCustomSlippage] = useState('');
  const [pressedPreset, setPressedPreset] = useState<number | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [caCopied, setCaCopied] = useState(false);
  const [gaslessTradingEnabled, setGaslessTradingEnabled] = useState(true);
  const extremePriceImpact = plan?.legs.some(leg => leg.quote.view.priceImpactPct != null && Math.abs(leg.quote.view.priceImpactPct) > 50) ?? false;
  const quoteSeq = useRef(0);
  const amountRef = useRef<React.ComponentRef<typeof TextInput>>(null);
  const settings = useSettings();
  useEffect(() => { if (settingsOpen) { setDraftSlippage(settings.slippageBps ?? null); setCustomSlippage(settings.slippageBps != null && ![50,100,300].includes(settings.slippageBps) ? String(settings.slippageBps / 100) : ''); } }, [settingsOpen, settings.slippageBps]);

  useEffect(() => subscribeToWallet(setWallet), []);
  useEffect(() => { loadGaslessTradingEnabled().then(setGaslessTradingEnabled); }, []);
  useEffect(() => { setSide(initialSide); }, [initialSide]);

  const support = selectedToken ? tradeSupportFor(selectedToken, wallet ? { kind: walletKind(wallet)! } : null) : null;
  const token = support?.ok && selectedToken && selectedToken.chainKey !== 'near'
    ? { ...selectedToken, chainKey: support.chainKey as ChainKey }
    : null;
  const address = wallet?.address ?? null;
  const nearToken = selectedToken?.chainKey === 'near' && wallet?.source === 'local' && wallet?.nearAddress
    ? (selectedToken as KivoToken & { chainKey: 'near' })
    : null;

  // Reset the ticket whenever the token, side or wallet changes.
  useEffect(() => {
    setAmount(''); setQuote(null); setQuoteState('idle'); setQuoteError(''); setResult(null);
    setCash(null); setTokenBalance(null); setBalanceError('');
    quoteSeq.current++;
  }, [selectedToken?.chainKey, selectedToken?.tokenAddress, side, address]);

  // Real balances: USDC per chain for buys, the token itself for sells.
  useEffect(() => {
    if (!token || !address) return;
    let cancelled = false;
    // Cash (USDC on every supported chain) feeds the header total on both sides.
    fetchCashBalances(address, undefined, wallet?.solanaAddress).then(rows => {
      if (cancelled) return;
      setCash(rows);
    });
    if (side === 'sell') {
      const owner = token.chainKey === 'solana' ? wallet?.solanaAddress : address;
      if (!owner) { setBalanceError('This wallet has no Solana address.'); return () => { cancelled = true; }; }
      readTokenBalance(token.chainKey, token.tokenAddress, owner, token.symbol)
        .then(balance => { if (!cancelled) setTokenBalance(balance); })
        .catch(error => { if (!cancelled) setBalanceError(error instanceof Error ? error.message : 'Balance unavailable.'); });
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token?.chainKey, token?.tokenAddress, side, address]);

  const available = side === 'buy'
    ? (cash && token ? totalSpendableCash(cash, token.chainKey) : null)
    : tokenBalance?.amount ?? null;
  const parsed = parseAmountInput(amount);
  // Buys are entered in USD; a sell is valued at the token's live price (the
  // quote below re-checks it once the route's real output is known).
  const tradeUsd = parsed == null ? null : side === 'buy' ? parsed : token?.priceUsd != null && token.priceUsd > 0 ? parsed * token.priceUsd : null;
  const amountProblem = !amount.trim() ? null : parsed == null ? 'Enter a valid amount greater than zero.'
    : available != null && parsed > available + 1e-12 ? `More than your available ${formatAmount(available)} ${side === 'buy' ? 'USDC' : token?.symbol ?? ''}.`
    : tradeUsd != null && tradeUsd < MIN_TRADE_USD ? `The minimum trade is ${formatUsd(MIN_TRADE_USD)}.` : null;

  const fetchQuote = useCallback(async () => {
    if (!token || !address || parsed == null || amountProblem) return;
    if (side === 'buy' && !cash) return;
    if (side === 'sell' && !tokenBalance) return;
    const seq = ++quoteSeq.current;
    setQuoteState('loading'); setQuote(null); setQuoteError('');
    try {
      // Same network as the user's cash: straight to Uniswap, Relay pays the gas.
      const direct = gaslessTradingEnabled
        ? await planDirectTrade({ side, token, amount: parsed, userAddress: address, solanaAddress: wallet?.source === 'local' ? wallet.solanaAddress : undefined, cash, tokenBalance, tokenDecimals: side === 'buy' ? tokenDecimals : tokenBalance?.decimals ?? 18, slippageBps: settings.slippageBps ?? undefined }).catch(() => null)
        : null;
      if (seq !== quoteSeq.current) return;
      if (direct) { setQuote({ legs: [], view: direct.view, direct }); setQuoteState('ready'); return; }
      const next: UnifiedPlan = side === 'buy'
        ? await planUnifiedBuy({ token, amountUsd: parsed, userAddress: address, solanaAddress: wallet?.source === 'local' ? wallet.solanaAddress : undefined, cash: cash!, tokenDecimals, slippageBps: settings.slippageBps ?? undefined })
        : await (async () => {
            const solanaOwner = token.chainKey === 'solana' ? wallet?.solanaAddress : undefined;
            if (token.chainKey === 'solana' && !solanaOwner) throw new Error('This wallet has no Solana address.');
            const single = await requestKivoQuote({ side, token, amount, userAddress: solanaOwner ?? address, recipientAddress: solanaOwner ?? address, payChain: token.chainKey, tokenDecimals: tokenBalance?.decimals ?? 18, slippageBps: settings.slippageBps ?? undefined, execution: gaslessTradingEnabled ? 'gasless' : 'wallet' });
            return { legs: [{ chainKey: token.chainKey, amountUsd: single.view.pay.usd ?? 0, quote: single }], view: single.view };
          })();
      if (seq !== quoteSeq.current) return;
      setQuote(next); setQuoteState('ready');
    } catch (error) {
      if (seq !== quoteSeq.current) return;
      setQuoteState('error'); setQuoteError(describeQuoteError(error));
    }
  }, [token, address, parsed, amountProblem, side, cash, tokenBalance, amount, settings.slippageBps, gaslessTradingEnabled]);

  // Debounced auto-quote while typing.
  useEffect(() => {
    quoteSeq.current++;
    setQuote(null); setQuoteState('idle');
    if (parsed == null || amountProblem) return;
    const timer = setTimeout(fetchQuote, 650);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount, cash, tokenBalance?.decimals, settings.slippageBps]);

  useEffect(() => {
    if (quoteState !== 'ready') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [quoteState]);

  const preflight = useMemo(() => {
    if (!plan || !address) return null;
    // Relay quotes bind to the chain-specific owner. Solana SELL requests use
    // the Solana public key, not the wallet's unrelated EVM (0x...) address.
    // Compare the quote against the matching account while keeping the
    // execution-time signer and transaction-intent checks unchanged.
    const quoteSignerAddress = token?.chainKey === 'solana' ? wallet?.solanaAddress : address;
    if (!quoteSignerAddress) return { ok: false as const, error: 'This wallet has no Solana address. Refresh the quote.' };
    try { return { ok: true as const, warnings: plan.legs.flatMap(leg => preflightKivoQuote(leg.quote, quoteSignerAddress, Date.now(), {allowSolana: true}).warnings) }; }
    catch (error) { return { ok: false as const, error: error instanceof Error ? error.message : 'Safety check failed.' }; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, address, wallet?.solanaAddress, token?.chainKey, reviewOpen]);

  const choosePreset = (pct: number) => {
    if (available == null) return;
    if (side === 'sell' && pct === 100 && tokenBalance) {
      const raw = tokenBalance.raw.toString().padStart(tokenBalance.decimals + 1, '0');
      const whole = raw.slice(0, raw.length - tokenBalance.decimals) || '0';
      const fraction = raw.slice(raw.length - tokenBalance.decimals).replace(/0+$/, '');
      setAmount(fraction ? `${whole}.${fraction}` : whole);
      return;
    }
    const decimals = side === 'sell' ? (tokenBalance?.decimals ?? 6) : 6; const scale = 10 ** decimals; setAmount(String(Math.floor(available * pct / 100 * scale) / scale));
  };

  const execute = async () => {
    // A ref, not state: two taps in the same frame must not start two trades.
    if (!plan || !token || running || executingRef.current) return;
    if (extremePriceImpact) { setResult({tone:'error',message:'Trade blocked: route price impact is above 50%.',hashes:[],chainIds:[],requestId:null}); return; }
    executingRef.current = true;
    setRunning(true); setResult(null); setUpdate(null);
    const view = plan.view;
    const tokenInfo = { chainKey: token.chainKey, address: token.tokenAddress, symbol: token.symbol, name: token.name, imageUrl: token.imageUrl };
    try {
      // Re-check live token security immediately before the signing prompt.
      // A transient/unavailable GoPlus response is inconclusive and does not
      // block a trade; an explicit honeypot flag blocks buys.
      if (side === 'buy') {
        const security = token.chainKey === 'solana'
          ? await checkSolanaTokenSecurity(token.tokenAddress)
          : await checkTokenSecurity(MAINNET_CHAIN_IDS[token.chainKey], token.tokenAddress);
        if (security?.isHoneypot) throw new KivoExecutionError('GoPlus flagged this token as a possible honeypot. Kivo blocked the buy before signing.');
      }

      // Unlock once. Before ANY broadcast, validate every leg's intent and
      // gasless sponsorship capability. This prevents leg 1 from succeeding
      // and leg 2 failing because sponsorship/route safety was only checked later.
      const outcome = await withDeviceAccounts(`Confirm ${side} ${token.symbol}`, async ({evm, evmPrivateKey, solana}) => {
        const session = {
          evm: {address: evm.address, privateKey: evmPrivateKey},
          solana: {address: solana ? solana.publicKey.toBase58() : '', privateKey: solana ? bs58.encode(solana.secretKey) : ''},
          authMethod: 'seed' as const,
        };
        const done = { status: 'success' as 'success' | 'pending' | 'refunded', txHashes: [] as string[], chainIds: [] as number[], requestId: null as string | null };
        if (plan.direct) {
          setUpdate({stage: 'awaiting-signature', step: 1, totalSteps: 1, txHashes: [], requestId: null, message: 'Processing trade…'});
          const sent = await executeDirectPlan(plan.direct, session);
          return { ...done, txHashes: sent.txHashes, chainIds: sent.chainIds, requestId: sent.requestId };
        }
        for (let index = 0; index < plan.legs.length; index++) {
          const leg = plan.legs[index];
          try {
            // Same as Mango Pro: if the pool moved before anything was sent,
            // re-run this leg's exact quote request once.
            const requote = () => requestKivoQuote(leg.quote.request).then(next => next.quote);
            const hasSolanaStep = (leg.quote.quote.steps ?? []).some(step => (step.items ?? []).some(item => Boolean(item.data?.instructions)));
            const legResult = hasSolanaStep
              ? await executeRelayQuote(leg.quote.quote, session, step => setUpdate({stage: step === 'build' ? 'preflight' : step === 'signing' ? 'awaiting-signature' : step === 'filling' ? 'filling' : 'success', step: index + 1, totalSteps: plan.legs.length, txHashes: [...done.txHashes], requestId: done.requestId, message: step === 'done' ? 'Trade complete.' : 'Processing trade…'}), {requote})
              : await (async () => {
                  return executeRelayQuote(leg.quote.quote, session, step => setUpdate({stage: step === 'build' ? 'preflight' : step === 'signing' ? 'awaiting-signature' : step === 'filling' ? 'filling' : 'success', step: index + 1, totalSteps: plan.legs.length, txHashes: [...done.txHashes], requestId: done.requestId, message: step === 'done' ? 'Trade complete.' : 'Processing trade…'}), {useGaslessTrading: gaslessTradingEnabled, requote});
                })();
            done.txHashes.push(...legResult.txHashes);
            // A leg Relay hasn't settled yet (or refunded) makes the whole trade not-yet-successful.
            if (legResult.status === 'pending' && done.status === 'success') done.status = 'pending';
            if (legResult.status === 'refunded') done.status = 'refunded';
            if (legResult.requestId) done.requestId = done.requestId ?? legResult.requestId;
            const legChainIds = (leg.quote.quote.steps ?? []).flatMap(step => (step.items ?? []).map(item => Number(item.data?.chainId)).filter(id => Number.isInteger(id) && id > 0));
            done.chainIds.push(...Array.from(new Set(legChainIds)));
            const legRequestId = (leg.quote.quote.steps ?? []).map(step => step.requestId).find(Boolean) ?? null;
            done.requestId = done.requestId ?? legRequestId;
          } catch (legError) {
            const message = legError instanceof Error ? legError.message : 'Trade failed.';
            const partial = index > 0 ? ` ${index} of ${plan.legs.length} parts already completed; the rest was not sent.` : '';
            throw new KivoExecutionError(message + partial, [...done.txHashes, ...(legError instanceof KivoExecutionError ? legError.txHashes : getPartialTxHashes(legError))]);
          }
        }
        return done;
      });
      const tone = outcome.status === 'success' ? 'success' : 'pending';
      const message = outcome.status === 'success' ? `${side === 'buy' ? 'Bought' : 'Sold'} ${token.symbol}.`
        : outcome.status === 'refunded' ? 'The route could not be filled and was refunded.' : 'Submitted — the route is still settling.';
      setResult({ tone, message, hashes: outcome.txHashes, chainIds: outcome.chainIds, requestId: outcome.requestId,
        receipt: { paid: `${view.pay.amount} ${cashLabel(view.pay.symbol)}`, received: `${view.receive.amount ? formatAmount(Number(view.receive.amount)) : '—'} ${cashLabel(view.receive.symbol)}`, feesUsd: view.totalFeeUsd ?? null } });
      // Bookkeeping must never turn a sent trade into an error.
      void markOwnAction(address!).catch(() => {});
      recordTrade({ side, token: tokenInfo, pay: { amount: view.pay.amount, symbol: view.pay.symbol, chainKey: view.pay.chainKey }, receive: { amount: view.receive.amount, symbol: view.receive.symbol, chainKey: view.receive.chainKey }, txHashes: outcome.txHashes, chainIds: outcome.chainIds, requestId: outcome.requestId, status: outcome.status });
      addNotification(outcome.status === 'success' ? (side === 'buy' ? `Bought ${token.symbol}` : `Sold ${token.symbol}`) : outcome.status === 'refunded' ? 'Trade refunded' : 'Trade submitted', `${Number(view.pay.amount).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${cashLabel(view.pay.symbol)}${view.receive.amount ? ` → ${Number(view.receive.amount).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${cashLabel(view.receive.symbol)}` : ''} on ${chainLabel(token.chainKey)}`);
    } catch (error) {
      const hashes = error instanceof KivoExecutionError ? error.txHashes : [];
      const message = error instanceof Error ? error.message : 'Trade failed.';
      setResult({ tone: 'error', message: hashes.length ? `${message} Some transactions were already sent; check them before trying again.` : message, hashes, chainIds: [], requestId: null });
      if (hashes.length) recordTrade({ side, token: tokenInfo, pay: { amount: view.pay.amount, symbol: view.pay.symbol, chainKey: view.pay.chainKey }, receive: { amount: view.receive.amount, symbol: view.receive.symbol, chainKey: view.receive.chainKey }, txHashes: hashes, chainIds: [], requestId: null, status: 'failed', error: message });
    } finally {
      executingRef.current = false;
      setRunning(false);
    }
  };

  const closeReview = () => {
    if (running) return;
    setReviewOpen(false);
    if (result && result.tone !== 'error') { setAmount(''); setCash(null); setTokenBalance(null); }
    setResult(null); setUpdate(null);
  };

  const view = plan?.view;
  const expired = view ? isQuoteExpired(view, now) : false;

  const feePct = view && view.fees.appUsd != null && view.pay.usd ? (view.fees.appUsd / view.pay.usd) * 100 : null;
  const cashTotal = cash ? totalCashUsd(cash).total : null;
  // The route's own USD value decides the minimum when the token had no live price.
  const quotedUsd = view ? (side === 'buy' ? view.pay.usd : view.receive.usd) : null;
  const belowMinimum = quotedUsd != null && quotedUsd < MIN_TRADE_USD;
  const ready = quoteState === 'ready' && Boolean(view) && !expired && !view?.unsupportedReason && !belowMinimum && !extremePriceImpact && walletKind(wallet) === 'evm-local';
  // Honest gas line: only say Kivo pays when it really does. Solana trades
  // are paid by Kivo's fee payer and direct swaps by Relay; Relay-routed EVM
  // legs only when Kivo's server confirmed Relay accepted sponsorship.
  const gasSponsored = !plan ? null
    : plan.direct ? true
    : plan.legs.every(leg => leg.chainKey === 'solana' || quoteSponsorshipStatus(leg.quote.quote) === 'on');
  const gasLabel = gasSponsored === false
    ? (view?.fees.gasUsd != null ? `${formatUsd(view.fees.gasUsd)} (in route fees)` : 'Included in route fees')
    : 'Paid by Kivo';
  const tradeChain: ChainKey | null = token?.chainKey ?? (selectedToken?.chainKey !== 'near' ? selectedToken?.chainKey ?? null : null);
  const receiveSymbol = side === 'buy' ? token?.symbol ?? '' : token ? cashLabel(sellProceedsAsset(token.chainKey).symbol) : '';
  const hint = extremePriceImpact ? 'Trade blocked — route price impact is above 50%.'
    : !wallet ? 'Create or import a Kivo wallet on this phone to trade.'
    : amountProblem ?? (parsed == null ? `Enter an amount to ${side} ${token?.symbol ?? ''}`
      : quoteState === 'loading' ? 'Finding the best route…'
      : quoteState === 'error' ? quoteError
      : expired ? 'Quote expired — tap Refresh.'
      : view?.unsupportedReason ? view.unsupportedReason
      : belowMinimum ? `The minimum trade is ${formatUsd(MIN_TRADE_USD)}.`
      : quoteState === 'ready' ? `Review and ${side} ${token?.symbol ?? ''}` : '');
  const hintIsError = Boolean(amountProblem) || quoteState === 'error' || Boolean(view?.unsupportedReason) || belowMinimum;
  const pressSide = (target: TradeSide) => {
    if (target !== side) { setSide(target); return; }
    if (ready) setReviewOpen(true);
    else if (expired) fetchQuote();
  };
  const disabledInput = !wallet || !token;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Pressable style={styles.cashRow} onPress={() => { if (cash) setChainOpen(true); }} accessibilityRole="button" accessibilityLabel="Cash by network">
        <Text style={styles.cashLabel}>Cash{cash ? '  ›' : ''}</Text>
        <Text style={styles.cashValue}>{!wallet ? '—' : cashTotal == null ? '…' : settings.hideBalances ? '••••' : formatUsd(cashTotal)}</Text>
      </Pressable>
      <View style={styles.toolbar}>
        <Pressable onPress={() => setNetworkOpen(true)} style={[styles.pill, styles.grow]} accessibilityRole="button" accessibilityLabel="Choose network">
          <Text style={styles.pillMuted} numberOfLines={1}>Trading on <Text style={styles.pillStrong}>{selectedToken?.chainKey === 'near' ? tradeChainLabel('near') : tradeChain ? chainLabel(tradeChain) : 'any network'}</Text>  ›</Text>
        </Pressable>
        <Pressable onPress={onToken} style={styles.pill}><Text style={styles.pillStrong}>⌕  Search</Text></Pressable>
        <Pressable onPress={() => setSettingsOpen(true)} style={styles.round} accessibilityLabel="Trade settings"><Text style={styles.gear}>⚙</Text></Pressable>
      </View>

      <Pressable onPress={onToken} style={styles.tokenRow} accessibilityRole="button">
        {selectedToken?.imageUrl ? <Image source={{ uri: selectedToken.imageUrl }} style={styles.tokenIcon} /> : <View style={styles.tokenIcon}><Text style={styles.tokenLetter}>{(selectedToken?.symbol ?? '⌕').slice(0, 1)}</Text></View>}
        <View style={styles.flex}>
          <Text style={styles.tokenSymbol}>{selectedToken ? selectedToken.symbol : 'Choose a token'}</Text>
          <Text style={styles.muted} numberOfLines={1}>{selectedToken ? `${selectedToken.name} · ${chainLabel(selectedToken.chainKey)}` : 'Search any token, any chain'}</Text>
        </View>
        {selectedToken?.tokenAddress ? (
          <Pressable onPress={() => { Clipboard.setString(selectedToken.tokenAddress); setCaCopied(true); setTimeout(() => setCaCopied(false), 2000); }} hitSlop={8} style={[styles.copyCa, caCopied && styles.copyCaDone]} accessibilityRole="button" accessibilityLabel={caCopied ? 'Contract address copied' : 'Copy contract address'}>
            <Text style={styles.copyCaText}>{caCopied ? '✓' : '⧉'}</Text>
          </Pressable>
        ) : null}
        {selectedToken ? <View style={styles.right}><Text style={styles.tokenPrice}>{formatUsd(selectedToken.priceUsd)}</Text>{selectedToken.change24h != null && <Text style={[styles.small, { color: selectedToken.change24h >= 0 ? kivoTheme.colors.success : kivoTheme.colors.danger }]}>{selectedToken.change24h >= 0 ? '+' : ''}{selectedToken.change24h.toFixed(2)}%</Text>}</View> : <Text style={styles.chevron}>›</Text>}
        {onOpenHistory ? <Pressable onPress={onOpenHistory} hitSlop={10} style={styles.historyButton} accessibilityLabel="Trade history"><Text style={styles.gear}>⟲</Text></Pressable> : null}
      </Pressable>

      {!selectedToken ? <Text style={styles.note}>Pick a token from Discover or Search to open a live trade ticket.</Text>
        : nearToken ? (
          <NearTradePanel
            token={nearToken}
            wallet={wallet!}
            initialSide={side}
            onOpenHistory={onOpenHistory}
          />
        ) : !support?.ok ? <View style={styles.notice}><Text style={styles.noticeText}>{support?.reason}</Text></View>
        : (
          <>
            <TokenChartPanel token={token!} />

            <View style={styles.sides}>
              <Pressable onPress={() => pressSide('buy')} style={[styles.buy, side !== 'buy' && styles.inactive]}>
                <Text style={styles.buyText}>↑  {'Buy'}</Text>
              </Pressable>
              <Pressable onPress={() => pressSide('sell')} style={[styles.sell, side === 'sell' && ready && styles.sellReady, side !== 'sell' && styles.inactive]}>
                <Text style={[styles.sellText, side === 'sell' && ready && styles.sellTextReady]}>↓  {'Sell'}</Text>
              </Pressable>
            </View>
            {hint ? <Text style={[styles.hint, hintIsError && styles.hintError]}>{hint}</Text> : null}
            {quoteState === 'error' || expired ? <Pressable onPress={fetchQuote} style={styles.refresh}><Text style={styles.refreshText}>{expired ? 'Refresh quote' : 'Try again'}</Text></Pressable> : null}

            <View style={styles.presets}>
              {[25, 50, 75, 100].map(pct => (
                <Pressable
                  key={pct}
                  disabled={available == null || available <= 0}
                  onPress={() => choosePreset(pct)}
                  onPressIn={() => setPressedPreset(pct)}
                  onPressOut={() => setPressedPreset(null)}
                  style={[
                    styles.preset,
                    pressedPreset === pct && styles.presetPressed,
                    (available == null || available <= 0) && styles.disabled,
                  ]}
                >
                  <Text style={styles.presetText}>{pct === 100 ? 'MAX' : `${pct}%`}</Text>
                </Pressable>
              ))}
              <Pressable
                disabled={disabledInput}
                onPress={() => amountRef.current?.focus()}
                onPressIn={() => setPressedPreset(0)}
                onPressOut={() => setPressedPreset(null)}
                style={[
                  styles.preset,
                  styles.presetCustom,
                  pressedPreset === 0 && styles.presetPressed,
                  disabledInput && styles.disabled,
                ]}
              >
                <Text style={[styles.presetText, styles.presetCustomText]}>Custom</Text>
              </Pressable>
            </View>

            <View style={styles.cardsRow}>
            <View style={styles.card}>
              <Text style={styles.cardLabel}>YOU PAY</Text>
              <View style={styles.cardRow}>
                <AssetChip symbol={side === 'buy' ? 'USDC' : token!.symbol} uri={side === 'buy' ? null : token!.imageUrl} />
                <TextInput ref={amountRef} editable={!disabledInput} value={amount} onChangeText={value => setAmount(normalizeAmountInput(value))} keyboardType="decimal-pad" placeholder="0" placeholderTextColor={kivoTheme.colors.textMuted} style={styles.amountInput} accessibilityLabel={side === 'buy' ? 'USDC to spend' : `${token!.symbol} to sell`} />
              </View>
              <Text style={styles.avail}>{!wallet ? '' : available != null ? `${formatAmount(available)} avail.` : side === 'sell' && balanceError ? 'Balance unavailable' : 'Reading balance…'}</Text>
            </View>
            <View style={styles.card}>
              <Text style={styles.cardLabel}>YOU RECEIVE</Text>
              <View style={styles.cardRow}>
                <AssetChip symbol={receiveSymbol} uri={side === 'buy' ? token!.imageUrl : null} />
                {quoteState === 'loading' ? <ActivityIndicator color={kivoTheme.colors.accent} /> : <Text style={styles.receive} numberOfLines={1} adjustsFontSizeToFit>{view?.receive.amount ? formatAmount(Number(view.receive.amount)) : '—'}</Text>}
              </View>
              <Text style={styles.avail}>{view?.receive.usd != null ? `≈ ${formatUsd(view.receive.usd)}` : ''}</Text>
            </View>

            </View>

            <View style={styles.feeRow}>
              <View style={[styles.dot, view && styles.dotLive]} />
              <Text style={styles.feeStrong}>{view ? `Fee ${feePct != null ? feePct.toFixed(1) + '%' : formatUsd(view.totalFeeUsd)}` : 'Fee —'}</Text>
              <Text style={[styles.small, styles.flex]}>{!gaslessTradingEnabled ? '  ·  Network fee from your wallet' : gasSponsored === false ? '  ·  Gas in route fees' : '  ·  Gas free'}{view?.etaSeconds != null ? `  ·  ETA ${view.etaSeconds < 60 ? `~${view.etaSeconds}s` : `~${Math.round(view.etaSeconds / 60)} min`}` : ''}</Text>
              {view ? <Pressable onPress={() => setShowDetails(value => !value)} hitSlop={8}><Text style={styles.detailsLink}>{showDetails ? 'Hide' : 'Details'}</Text></Pressable> : null}
            </View>
            {view && showDetails && (
              <View style={styles.details}>
                <QuoteRow label="Minimum received" value={view.minimumReceived ? `${formatAmount(Number(view.minimumReceived))} ${cashLabel(view.receive.symbol)}` : 'Not provided by route'} />
                <QuoteRow label="Price impact" value={view.priceImpactPct == null ? '—' : `${view.priceImpactPct.toFixed(2)}%`} danger={view.priceImpactPct != null && Math.abs(view.priceImpactPct) >= 5} />
                <QuoteRow label="Route fees" value={formatUsd(view.totalFeeUsd)} />
                <QuoteRow label="Network gas" value={gasLabel} />
                <QuoteRow label="Max slippage" value={view.slippagePct == null ? 'Auto' : `${view.slippagePct}%`} />
                <QuoteRow label="Route" value={view.routeLabel} />
                <QuoteRow label="You sign" value={view.transactionCount > 1 ? `Once (${view.transactionCount} steps batched)` : 'Once'} />
                <QuoteRow label="Quote" value={expired ? 'Expired' : `Refreshes in ${Math.max(0, Math.ceil((view.expiresAt - now) / 1000))}s`} />
              </View>
            )}
          </>
        )}

      <KivoModal visible={networkOpen} transparent animationType="slide" onRequestClose={() => setNetworkOpen(false)}>
        <Pressable style={styles.sheetBackdrop} onPress={() => setNetworkOpen(false)}>
          <Pressable style={[styles.sheet, styles.networkSheet]} onPress={() => {}}>
            <Text style={styles.sheetTitle}>Trading on</Text>
            <Text style={styles.noticeText}>Pick a network to see its tokens. Buys are paid from your USDC on any network; Kivo routes it there gas-free.</Text>
            <ScrollView showsVerticalScrollIndicator={false}>
              {TRADE_CHAIN_ORDER.map(chain => {
                const active = (selectedToken?.chainKey ?? null) === chain;
                return (
                  <Pressable key={chain} onPress={() => { setNetworkOpen(false); onPickChain?.(chain); }} style={[styles.payRow, active && styles.payRowSelected]} accessibilityRole="button">
                    <NetworkIcon chainKey={chain} size={22} />
                    <Text style={[styles.payName, styles.networkName]}>{tradeChainLabel(chain)}</Text>
                    <Text style={styles.chevron}>{active ? '✓' : '›'}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          </Pressable>
        </Pressable>
      </KivoModal>

      <KivoModal visible={chainOpen} transparent animationType="slide" onRequestClose={() => setChainOpen(false)}>
        <Pressable style={styles.sheetBackdrop} onPress={() => setChainOpen(false)}>
          <Pressable style={styles.sheet} onPress={() => {}}>
            <Text style={styles.sheetTitle}>Your cash</Text>
            <Text style={styles.noticeText}>Buys spend your total USDC across every network. You never pick a chain: Kivo routes each part straight to {tradeChain ? chainLabel(tradeChain) : 'the token'}, gas-free.</Text>
            {(cash ?? []).filter(r => r.status === 'error' || r.balance.amount > 0).map(row => {
              const leg = plan?.legs.find(l => l.chainKey === row.chainKey);
              return (
                <View key={row.chainKey} style={[styles.payRow, leg && styles.payRowSelected]}>
                  <Text style={styles.payName}>{CHAIN_LABEL[row.chainKey]}</Text>
                  <Text style={styles.payAmount}>{row.status === 'ok' ? `${formatAmount(row.balance.amount, 2)} USDC` : 'Unavailable'}</Text>
                  {leg && <Text style={styles.check}>  uses {leg.amountUsd.toFixed(2)}</Text>}
                </View>
              );
            })}
            {plan && plan.legs.length > 1 && side === 'buy' && <Text style={styles.small}>This buy is split across {plan.legs.length} networks, each part checked by the firewall and signed together.</Text>}
          </Pressable>
        </Pressable>
      </KivoModal>

      <KivoModal visible={settingsOpen} transparent animationType="slide" onRequestClose={() => setSettingsOpen(false)}>
        <Pressable style={styles.sheetBackdrop} onPress={() => setSettingsOpen(false)}>
          <Pressable style={[styles.sheet, styles.settingsSheet]} onPress={() => {}}>
            <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              <View style={styles.settingsHeader}>
                <Text style={styles.sheetTitle}>Trade Settings</Text>
                <View style={styles.activeBadge}><Text style={styles.activeBadgeText}>Active: {draftSlippage == null ? 'Auto' : (draftSlippage / 100) + '%'}</Text></View>
              </View>
              <Text style={styles.settingsLabel}>Slippage</Text>
              <Text style={styles.noticeText}>Max slippage — the most the price may move before the route refuses to fill. Auto lets the router choose a safe bound for each route.</Text>
              <View style={styles.slippageRow}>
                {[null, 50, 100, 300].map(bps => (
                  <Pressable key={String(bps)} onPress={() => { setDraftSlippage(bps); setCustomSlippage(''); }} style={[styles.chip, draftSlippage === bps && !customSlippage && styles.chipActive]}>
                    <Text style={[styles.chipText, draftSlippage === bps && !customSlippage && styles.chipTextActive]}>{bps == null ? 'Auto' : (bps / 100) + '%'}</Text>
                  </Pressable>
                ))}
              </View>
              <View style={styles.customRow}>
                <Pressable style={[styles.chip, styles.customChip, customSlippage.length > 0 && styles.chipActive]} onPress={() => setCustomSlippage(customSlippage || (draftSlippage != null ? String(draftSlippage / 100) : ''))}>
                  <Text style={[styles.chipText, customSlippage.length > 0 && styles.chipTextActive]}>Custom</Text>
                </Pressable>
                <TextInput value={customSlippage} onChangeText={value => { const pct = Number(value); setCustomSlippage(value); setDraftSlippage(Number.isFinite(pct) && pct > 0 && pct <= 100 ? Math.round(pct * 100) : null); }} placeholder="0.00" placeholderTextColor={c.textMuted} keyboardType="decimal-pad" style={styles.customInput} />
                <Text style={styles.customPercent}>%</Text>
              </View>
              {customSlippage.length > 0 && draftSlippage == null && <Text style={styles.error}>Enter a value between 0.01 and 100.</Text>}
              {draftSlippage != null && draftSlippage > 500 && <Text style={styles.warning}>High slippage tolerance — you may receive significantly less than quoted.</Text>}
              <Text style={styles.minimumReceived}>Minimum received = quoted × (1 − {draftSlippage != null ? (draftSlippage / 100) + '%' : '0%'})</Text>
              <Pressable style={styles.saveButton} onPress={() => { updateSettings({ slippageBps: draftSlippage }); setSettingsOpen(false); }}>
                <Text style={styles.saveButtonText}>Save</Text>
              </Pressable>
              <Text style={styles.settingsHint}>Closing without saving keeps {settings.slippageBps == null ? 'Auto' : (settings.slippageBps / 100) + '%'} active.</Text>
            </ScrollView>
          </Pressable>
        </Pressable>
      </KivoModal>
      <KivoModal visible={reviewOpen} transparent animationType="slide" onRequestClose={closeReview}>
        <View style={styles.sheetBackdrop}>
          <View style={styles.sheet}>
            <ScrollView style={styles.reviewScroll} contentContainerStyle={styles.reviewScrollContent} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
            <Text style={styles.sheetTitle}>Confirm {side}</Text>
            {view && <>
              <View style={styles.summary}>
                <View style={styles.flex}><Text style={styles.small}>You pay</Text><Text style={styles.summaryValue}>{view.pay.amount} {cashLabel(view.pay.symbol)}</Text><Text style={styles.small}>{CHAIN_LABEL[view.pay.chainKey]}</Text></View>
                <Text style={styles.chevron}>›</Text>
                <View style={[styles.flex, styles.right]}><Text style={styles.small}>Minimum received</Text><Text style={styles.summaryValue}>{view.minimumReceived ? formatAmount(Number(view.minimumReceived)) : '—'} {cashLabel(view.receive.symbol)}</Text><Text style={styles.small}>{CHAIN_LABEL[view.receive.chainKey]}</Text></View>
              </View>
              <QuoteRow label="Route fees" value={formatUsd(view.totalFeeUsd)} />
              <QuoteRow label="Network gas" value={gasLabel} />
              <QuoteRow label="Signing wallet" value={shortAddress(token?.chainKey === 'solana' ? wallet?.solanaAddress ?? null : address)} />
            </>}
            {preflight && !preflight.ok
              ? <Text style={styles.error}>{preflight.error}</Text>
              : <Text style={styles.okText}>Kivo checked every transaction in this route against your trade before anything is signed.{preflight?.ok && preflight.warnings.length ? ` ${preflight.warnings.join(' ')}` : ''}</Text>}
            {(update || result) && (
              <View style={styles.timeline}>
                {STAGES.map(([stages, label], index) => {
                  const activeIndex = update ? STAGES.findIndex(([s]) => s.includes(update.stage)) : -1;
                  const done = result?.tone === 'success' || index < activeIndex;
                  const failed = result?.tone === 'error' && index === Math.max(activeIndex, 0);
                  return <Text key={label} style={[styles.stage, done && styles.stageDone, index === activeIndex && !result && styles.stageActive, failed && styles.stageFailed]}>{done ? '●' : '○'}  {label}</Text>;
                })}
                {update && !result && <Text style={styles.small}>{update.message}</Text>}
              </View>
            )}
            {result && (
              <View style={[styles.resultCard, result.tone === 'error' && styles.resultCardError, result.tone === 'success' && styles.resultCardSuccess]}>
                <Text style={[styles.resultTitle, result.tone === 'error' && styles.resultTitleError, result.tone === 'success' && styles.resultTitleSuccess]}>
                  {(side === 'sell' ? 'Sell' : 'Buy') + (result.tone === 'error' ? ' failed' : result.tone === 'pending' ? ' submitted' : ' complete')}
                </Text>
                <ScrollView style={styles.resultMessageScroll} nestedScrollEnabled>
                  <Text style={result.tone === 'error' ? styles.error : styles.okText}>{result.message}</Text>
                </ScrollView>
                {result.tone === 'success' && result.receipt ? <View style={styles.details}>
                  <QuoteRow label={side === 'buy' ? 'You paid' : 'You sold'} value={result.receipt.paid} />
                  <QuoteRow label="You received" value={result.receipt.received} />
                  <QuoteRow label="Fees" value={result.receipt.feesUsd == null ? '—' : formatUsd(result.receipt.feesUsd)} />
                </View> : null}
              </View>
            )}
            {result?.tone === 'success' && token && onShareToFeed ? (
              <Pressable onPress={() => { const draft = { chain: token.chainKey, address: token.tokenAddress, text: `Just ${side === 'buy' ? 'bought' : 'sold'} $${token.symbol} on Kivo` }; closeReview(); onShareToFeed(draft); }} style={styles.secondaryButton}><Text style={styles.secondaryText}>Share to feed</Text></Pressable>
            ) : null}
            {result?.hashes.map((hash, index) => {
              const url = transactionLink(hash, result.chainIds[index] ?? result.chainIds[0], token ? MAINNET_CHAIN_IDS[token.chainKey] : null);
              return <Pressable key={hash} hitSlop={8} onPress={() => { Linking.openURL(url).catch(() => {}); }}><Text style={styles.link}>Transaction {index + 1}: {shortAddress(hash, 10, 6)}  ↗ View on explorer</Text></Pressable>;
            })}
            {result?.requestId && <Pressable onPress={() => Linking.openURL(relayRequestUrl(result.requestId!))}><Text style={styles.link}>Route status</Text></Pressable>}
            {result ? (
              <Pressable onPress={closeReview} style={styles.secondaryButton}><Text style={styles.secondaryText}>Close</Text></Pressable>
            ) : (
              <>
                <Pressable disabled={running || !preflight?.ok} onPress={execute} style={({ pressed }) => [styles.primaryButton, side === 'sell' && styles.sellButton, (running || !preflight?.ok) && styles.disabled, pressed && styles.pressed]}>
                  {/* Immediate feedback: the first tap is enough (the safety check and wallet unlock take a moment). */}
                  {running ? <ActivityIndicator color={kivoTheme.colors.backgroundDeep} /> : null}
                  <Text style={styles.primaryText}>{running ? (update?.stage === 'awaiting-signature' ? 'Signing…' : update?.stage === 'filling' ? 'Submitting…' : 'Checking…') : 'Confirm and sign'}</Text>
                </Pressable>
                {!running && <Pressable onPress={closeReview} style={styles.ghostButton}><Text style={styles.secondaryText}>Cancel</Text></Pressable>}
              </>
            )}
            </ScrollView>
          </View>
        </View>
      </KivoModal>
    </ScrollView>
  );
}

const USDC_LOGO_URI = 'https://tokens.1inch.io/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.png';

/** Robinhood's cash coin (USDG) is part of the one USDC cash balance, so it reads as USDC, like Mango Pro. */
function cashLabel(symbol: string): string {
  return symbol === 'USDG' ? 'USDC' : symbol;
}

function AssetChip({ symbol, uri }: { symbol: string; uri?: string | null }) {
  const imageUri = uri ?? (symbol.toUpperCase() === 'USDC' ? USDC_LOGO_URI : null);
  return (
    <View style={styles.chipAsset}>
      {imageUri ? (
        <Image source={{ uri: imageUri }} style={styles.chipIcon} resizeMode="contain" />
      ) : (
        <View style={styles.chipIcon}><Text style={styles.chipLetter}>{symbol.slice(0, 1).toUpperCase()}</Text></View>
      )}
      <Text style={styles.chipSymbol}>{symbol}</Text>
    </View>
  );
}

function QuoteRow({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return <View style={styles.quoteRow}><Text style={styles.quoteLabel}>{label}</Text><Text style={[styles.quoteValue, danger && { color: kivoTheme.colors.danger }]}>{value}</Text></View>;
}

const c = {
  background: kivoTheme.colors.background,
  backgroundDeep: kivoTheme.colors.backgroundDeep,
  surface: kivoTheme.colors.surface,
  surfaceRaised: kivoTheme.colors.surfaceRaised,
  border: kivoTheme.colors.border,
  text: kivoTheme.colors.text,
  textMuted: kivoTheme.colors.textMuted,
  cream: kivoTheme.colors.cream,
  accent: kivoTheme.colors.accent,
  success: kivoTheme.colors.success,
  danger: kivoTheme.colors.danger,
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background },
  content: { padding: 16, paddingBottom: 48 },
  flex: { flex: 1 },
  right: { alignItems: 'flex-end' },
  muted: { color: c.textMuted, fontSize: 12.5 },
  small: { color: c.textMuted, fontSize: 11.5 },
  note: { color: c.textMuted, fontSize: 12, lineHeight: 18, marginTop: 14 },
  networkSheet: { maxHeight: '80%' },
  networkName: { flex: 1, marginLeft: 12 },
  cashRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 },
  cashLabel: { color: c.textMuted, fontSize: 14, fontWeight: '700' },
  cashValue: { color: c.cream, fontSize: 26, fontWeight: '900' },
  toolbar: { flexDirection: 'row', gap: 6, marginTop: 0 },
  pill: { height: 26, paddingHorizontal: 10, borderRadius: 999, borderWidth: 1, borderColor: c.border, justifyContent: 'center' },
  grow: { flex: 1 },
  pillMuted: { color: c.textMuted, fontSize: 10.5 },
  pillStrong: { color: c.text, fontWeight: '700', fontSize: 10.5 },
  round: { width: 26, height: 26, borderRadius: 13, borderWidth: 1, borderColor: c.border, alignItems: 'center', justifyContent: 'center' },
  gear: { color: c.cream, fontSize: 14 },
  tokenRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8 },
  tokenIcon: { width: 36, height: 36, borderRadius: 18, backgroundColor: c.surfaceRaised, alignItems: 'center', justifyContent: 'center' },
  tokenLetter: { color: c.cream, fontWeight: '800', fontSize: 15 },
  tokenSymbol: { color: c.text, fontWeight: '800', fontSize: 16 },
  tokenPrice: { color: c.text, fontWeight: '800', fontSize: 14 },
  copyCa: { width: 30, height: 30, borderRadius: 9, borderWidth: 1, borderColor: c.border, backgroundColor: c.surfaceRaised, alignItems: 'center', justifyContent: 'center', marginRight: 10 },
  copyCaDone: { borderColor: c.accent },
  copyCaText: { color: c.accent, fontSize: 15, fontWeight: '800' },
  historyButton: { width: 26, height: 26, borderRadius: 13, borderWidth: 1, borderColor: c.border, alignItems: 'center', justifyContent: 'center', marginLeft: 4 },
  chevron: { color: c.textMuted, fontSize: 22 },
  notice: { marginTop: 8, padding: 14, borderRadius: 16, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border },
  noticeText: { color: c.textMuted, fontSize: 13, lineHeight: 19 },
  sides: { flexDirection: 'row', gap: 8, marginTop: 10, marginBottom: 2 },
  buy: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: 11, borderRadius: 999, borderWidth: 1, backgroundColor: c.success, borderColor: c.success },
  buyText: { color: '#fff', fontWeight: '700', fontSize: 13.5 },
  sell: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: 11, borderRadius: 999, borderWidth: 1, borderColor: c.danger },
  sellReady: { backgroundColor: c.danger, borderColor: c.danger },
  sellText: { color: c.danger, fontWeight: '700', fontSize: 13.5 },
  sellTextReady: { color: '#fff' },
  inactive: { opacity: 0.55 },
  hint: { color: c.textMuted, fontSize: 11, textAlign: 'center', marginTop: -4, marginBottom: 6 },
  hintError: { color: c.danger },
  refresh: { alignSelf: 'center', marginTop: 6, paddingHorizontal: 14, height: 30, borderRadius: 999, backgroundColor: c.surfaceRaised, justifyContent: 'center' },
  refreshText: { color: c.cream, fontWeight: '700', fontSize: 11.5 },
  presets: { flexDirection: 'row', gap: 6, marginTop: 10, marginBottom: 2 },
  preset: { flex: 1, alignItems: 'center', backgroundColor: c.surface, borderRadius: 999, paddingVertical: 7 },
  presetCustom: { flex: 1, backgroundColor: c.surfaceRaised },
  presetPressed: { backgroundColor: c.backgroundDeep },
  presetText: { color: c.textMuted, fontWeight: '600', fontSize: 11 },
  presetCustomText: { color: c.cream, fontWeight: '700' },
  cardsRow: { flexDirection: 'row', gap: 8, marginTop: 12 },
  card: { flex: 1, minWidth: 0, padding: 12, borderRadius: 14, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface, gap: 0 },
  cardLabel: { color: c.textMuted, fontSize: 10, fontWeight: '700', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.6 },
  cardRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 6 },
  chipAsset: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: c.surfaceRaised, borderRadius: 999, paddingHorizontal: 6, paddingVertical: 3 },
  chipIcon: { width: 16, height: 16, borderRadius: 8, backgroundColor: c.background, alignItems: 'center', justifyContent: 'center' },
  chipLetter: { color: c.cream, fontWeight: '900', fontSize: 8 },
  chipSymbol: { color: c.text, fontWeight: '700', fontSize: 11 },
  amountInput: { flex: 1, minWidth: 0, color: c.text, fontSize: 16, fontWeight: '600', textAlign: 'right', paddingVertical: 0 },
  receive: { flex: 1, minWidth: 0, color: c.text, fontSize: 16, fontWeight: '600', textAlign: 'right' },
  avail: { color: c.textMuted, fontSize: 10, textAlign: 'right', minHeight: 14, marginTop: 4 },
  feeRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 10, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12, borderWidth: 1, borderColor: c.border, minHeight: 34 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: c.textMuted, marginRight: 0 },
  dotLive: { backgroundColor: c.success },
  feeStrong: { color: c.text, fontWeight: '500', fontSize: 11 },
  detailsLink: { color: c.accent, fontWeight: '700', fontSize: 11 },
  details: { marginTop: 6, paddingHorizontal: 4, paddingVertical: 0, borderRadius: 12, backgroundColor: c.surface },
  quoteRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 7, borderTopWidth: 1, borderTopColor: c.border },
  quoteLabel: { color: c.textMuted, fontSize: 11 },
  quoteValue: { color: c.text, fontSize: 11, fontWeight: '600', flexShrink: 1, textAlign: 'right', marginLeft: 12 },
  payRow: { flexDirection: 'row', alignItems: 'center', padding: 13, borderRadius: 14, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, marginBottom: 8 },
  payRowSelected: { borderColor: '#2FD67B' },
  payName: { flex: 1, color: c.text, fontWeight: '700', fontSize: 13 },
  payAmount: { color: c.text, fontWeight: '800', fontSize: 13 },
  check: { color: '#2FD67B', marginLeft: 8, fontWeight: '900' },
  slippageRow: { flexDirection: 'row', gap: 8, marginTop: 14 },
  chip: { flex: 1, height: 40, borderRadius: 20, backgroundColor: c.surface, alignItems: 'center', justifyContent: 'center' },
  chipActive: { backgroundColor: c.cream },
  chipText: { color: c.text, fontWeight: '800' },
  chipTextActive: { color: c.backgroundDeep },
  error: { color: c.danger, fontSize: 12, lineHeight: 18, marginTop: 6 },
  okText: { color: c.success, fontSize: 12, lineHeight: 18, marginTop: 10 },
  primaryButton: { marginTop: 12, height: 48, borderRadius: 24, backgroundColor: c.success, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8 },
  sellButton: { backgroundColor: c.danger },
  pressed: { opacity: 0.75 },
  primaryText: { color: c.backgroundDeep, fontWeight: '800', fontSize: 14.5, textTransform: 'capitalize' },
  secondaryButton: { marginTop: 12, height: 48, borderRadius: 24, backgroundColor: c.surfaceRaised, alignItems: 'center', justifyContent: 'center' },
  ghostButton: { marginTop: 8, height: 44, alignItems: 'center', justifyContent: 'center' },
  secondaryText: { color: c.cream, fontWeight: '800' },
  disabled: { opacity: 0.45 },
  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(1,15,13,0.7)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: c.background, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, paddingBottom: 34, borderWidth: 1, borderColor: c.border, maxHeight: '92%' },
  reviewScroll: { flexShrink: 1 },
  reviewScrollContent: { paddingBottom: 2 },
  resultCard: { marginTop: 12, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface },
  resultCardError: { borderColor: c.danger },
  resultCardSuccess: { borderColor: c.success },
  resultTitle: { color: c.text, fontSize: 13, fontWeight: '900', marginBottom: 4 },
  resultTitleError: { color: c.danger },
  resultTitleSuccess: { color: c.success },
  resultMessageScroll: { maxHeight: 100 },
  settingsSheet: { paddingBottom: 26 },
  settingsHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  activeBadge: { backgroundColor: c.surfaceRaised, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6 },
  activeBadgeText: { color: c.text, fontSize: 11, fontWeight: '800' },
  settingsLabel: { color: c.textMuted, fontSize: 12, fontWeight: '800', marginBottom: 8 },
  customRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  customChip: { flex: 0, paddingHorizontal: 16 },
  customInput: { flex: 1, height: 40, borderRadius: 20, backgroundColor: c.surface, color: c.text, paddingHorizontal: 14, textAlign: 'right' },
  customPercent: { color: c.text, fontWeight: '800' },
  warning: { color: c.danger, fontSize: 11.5, marginTop: 8 },
  minimumReceived: { color: c.textMuted, fontSize: 11, marginTop: 14, marginBottom: 16 },
  saveButton: { backgroundColor: '#2FD67B', borderRadius: 14, paddingVertical: 15, alignItems: 'center' },
  saveButtonText: { color: c.backgroundDeep, fontSize: 14.5, fontWeight: '900' },
  settingsHint: { color: c.textMuted, fontSize: 10.5, textAlign: 'center', marginTop: 10 },
  sheetTitle: { color: c.text, fontSize: 20, fontWeight: '800', marginBottom: 12, textTransform: 'capitalize' },
  summary: { flexDirection: 'row', alignItems: 'center', padding: 14, borderRadius: 16, backgroundColor: c.backgroundDeep, marginBottom: 8 },
  summaryValue: { color: c.text, fontWeight: '800', fontSize: 15, marginVertical: 2 },
  timeline: { marginTop: 12, gap: 6 },
  stage: { color: c.textMuted, fontSize: 13, fontWeight: '700' },
  stageActive: { color: c.text },
  stageDone: { color: c.success },
  stageFailed: { color: c.danger },
  link: { color: c.accent, fontWeight: '700', fontSize: 12.5, marginTop: 8 },
});
