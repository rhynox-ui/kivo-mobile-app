import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Image, Linking, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { kivoTheme } from '../theme/kivoTheme';
import { CHAIN_LABEL, TOKEN_ADDRESSES, type ChainKey } from '@kivo/trading/core/chainData';
import { fetchCashBalances, totalCashUsd, readTokenBalance, type CashBalanceRow, type TokenBalance } from '@kivo/trading/kivo/balances';
import { planUnifiedBuy, totalSpendableCash, type UnifiedPlan } from '@kivo/trading/kivo/unified';
import { explorerTxUrl, KivoExecutionError, preflightKivoQuote, relayRequestUrl, type ExecutionUpdate } from '@kivo/trading/kivo/execute';
import { executeKivoQuoteGasless, preflightGaslessQuote } from '@kivo/trading/kivo/gasless';
import { executeRelayQuote } from '@kivo/trading/core/executeRelayQuote';
import bs58 from 'bs58';
import { recordTrade } from '@kivo/trading/kivo/history';
import { describeQuoteError, isQuoteExpired, parseAmountInput, requestKivoQuote } from '@kivo/trading/kivo/quote';
import { chainLabel, formatAmount, formatUsd, nativeSymbol, shortAddress, tradeSupportFor, type KivoToken, type TradeSide } from '@kivo/trading/kivo/tokens';
import { getWalletSession, subscribeToWallet, walletKind, withDeviceAccounts, type WalletSession } from '../state/walletStore';
import { addNotification } from '../state/notificationStore';
import { updateSettings, useSettings } from '../state/settingsStore';
import { TokenChartPanel } from '../components/TokenChartPanel';
import { MAINNET_CHAIN_IDS } from '@kivo/trading/core/chainData';
import { checkSolanaTokenSecurity, checkTokenSecurity } from '@kivo/trading/core/goplusTokenSecurity';
import { NearTradePanel } from './NearTradePanel';

type QuoteState = 'idle' | 'loading' | 'ready' | 'error';
type ExecResult = { tone: 'success' | 'pending' | 'error'; message: string; hashes: string[]; chainIds: number[]; requestId: string | null };

// Gasless (Mango Pro model): one signature on the device, Relay submits and pays gas.
const STAGES: Array<[ExecutionUpdate['stage'][], string]> = [
  [['preflight'], 'Safety check'],
  [['switching-network', 'awaiting-signature', 'confirming'], 'Sign on this device'],
  [['filling', 'success', 'pending', 'refunded'], 'Relay submits · Kivo pays gas'],
];

export function TradeScreen({ onToken, selectedToken, initialSide = 'buy', onOpenHistory }: {
  onToken?: () => void;
  selectedToken?: KivoToken | null;
  initialSide?: TradeSide;
  onOpenHistory?: () => void;
}) {
  const [side, setSide] = useState<TradeSide>(initialSide);
  const [amount, setAmount] = useState('');
  const [wallet, setWallet] = useState<WalletSession | null>(getWalletSession());
  const [cash, setCash] = useState<CashBalanceRow[] | null>(null);
  const [tokenBalance, setTokenBalance] = useState<TokenBalance | null>(null);
  const [balanceError, setBalanceError] = useState('');
  // Buy: a unified-cash plan (one or more legs). Sell: a single-leg plan.
  const [plan, setQuote] = useState<UnifiedPlan | null>(null);
  const [quoteState, setQuoteState] = useState<QuoteState>('idle');
  const [quoteError, setQuoteError] = useState('');
  const [now, setNow] = useState(Date.now());
  const [reviewOpen, setReviewOpen] = useState(false);
  const [update, setUpdate] = useState<ExecutionUpdate | null>(null);
  const [result, setResult] = useState<ExecResult | null>(null);
  const [running, setRunning] = useState(false);
  const [chainOpen, setChainOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draftSlippage, setDraftSlippage] = useState<number | null>(null);
  const [customSlippage, setCustomSlippage] = useState('');
  const [showDetails, setShowDetails] = useState(false);
  const quoteSeq = useRef(0);
  const amountRef = useRef<React.ComponentRef<typeof TextInput>>(null);
  const settings = useSettings();
  useEffect(() => { if (settingsOpen) { setDraftSlippage(settings.slippageBps ?? null); setCustomSlippage(settings.slippageBps != null && ![50,100,300].includes(settings.slippageBps) ? String(settings.slippageBps / 100) : ''); } }, [settingsOpen, settings.slippageBps]);

  useEffect(() => subscribeToWallet(setWallet), []);
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
    fetchCashBalances(address).then(rows => {
      if (cancelled) return;
      setCash(rows);
    });
    if (side === 'sell') {
      readTokenBalance(token.chainKey, token.tokenAddress, address, token.symbol)
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
  const amountProblem = !amount.trim() ? null : parsed == null ? 'Enter a valid amount greater than zero.'
    : available != null && parsed > available + 1e-12 ? `More than your available ${formatAmount(available)} ${side === 'buy' ? 'USDC' : token?.symbol ?? ''}.` : null;

  const fetchQuote = useCallback(async () => {
    if (!token || !address || parsed == null || amountProblem) return;
    if (side === 'buy' && !cash) return;
    if (side === 'sell' && !tokenBalance) return;
    const seq = ++quoteSeq.current;
    setQuoteState('loading'); setQuote(null); setQuoteError('');
    try {
      const next: UnifiedPlan = side === 'buy'
        ? await planUnifiedBuy({ token, amountUsd: parsed, userAddress: address, cash: cash!, slippageBps: settings.slippageBps ?? undefined })
        : await (async () => {
            const single = await requestKivoQuote({ side, token, amount, userAddress: address, payChain: token.chainKey, tokenDecimals: tokenBalance?.decimals ?? 18, slippageBps: settings.slippageBps ?? undefined, execution: 'gasless' });
            return { legs: [{ chainKey: token.chainKey, amountUsd: single.view.pay.usd ?? 0, quote: single }], view: single.view };
          })();
      if (seq !== quoteSeq.current) return;
      setQuote(next); setQuoteState('ready');
    } catch (error) {
      if (seq !== quoteSeq.current) return;
      setQuoteState('error'); setQuoteError(describeQuoteError(error));
    }
  }, [token, address, parsed, amountProblem, side, cash, tokenBalance, amount, settings.slippageBps]);

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
    try { return { ok: true as const, warnings: plan.legs.flatMap(leg => preflightKivoQuote(leg.quote, address, Date.now(), {allowSolana: true}).warnings) }; }
    catch (error) { return { ok: false as const, error: error instanceof Error ? error.message : 'Safety check failed.' }; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, address, reviewOpen]);

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
    if (!plan || !token || running) return;
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
      const outcome = await withDeviceAccounts(`Confirm ${side} ${token.symbol}`, async ({evm, solana}) => {
        const session = {
          evm: {address: evm.address, privateKey: `0x${Buffer.from(evm.getHdKey().privateKey!).toString('hex')}`},
          solana: {address: solana.publicKey.toBase58(), privateKey: bs58.encode(solana.secretKey)},
          authMethod: 'seed' as const,
        };
        const done = { status: 'success' as 'success' | 'pending' | 'refunded', txHashes: [] as string[], chainIds: [] as number[], requestId: null as string | null };
        for (let index = 0; index < plan.legs.length; index++) {
          const leg = plan.legs[index];
          try {
            const hasSolanaStep = (leg.quote.quote.steps ?? []).some(step => (step.items ?? []).some(item => Boolean(item.data?.instructions)));
            const legResult = hasSolanaStep
              ? await executeRelayQuote(leg.quote.quote, session, step => setUpdate({stage: step === 'build' ? 'preflight' : step === 'signing' ? 'awaiting-signature' : step === 'filling' ? 'filling' : 'success', step: index + 1, totalSteps: plan.legs.length, txHashes: [...done.txHashes], requestId: done.requestId, message: step === 'done' ? 'Trade complete.' : 'Processing trade…'}))
              : await (async () => {
                  await preflightGaslessQuote(leg.quote, evm);
                  return executeKivoQuoteGasless(leg.quote, evm, setUpdate);
                })();
            done.txHashes.push(...legResult.txHashes);
            const legChainIds = (leg.quote.quote.steps ?? []).flatMap(step => (step.items ?? []).map(item => Number(item.data?.chainId)).filter(id => Number.isInteger(id) && id > 0));
            done.chainIds.push(...Array.from(new Set(legChainIds)));
            const legRequestId = (leg.quote.quote.steps ?? []).map(step => step.requestId).find(Boolean) ?? null;
            done.requestId = done.requestId ?? legRequestId;
          } catch (legError) {
            const message = legError instanceof Error ? legError.message : 'Trade failed.';
            const partial = index > 0 ? ` ${index} of ${plan.legs.length} parts already completed; the rest was not sent.` : '';
            throw new KivoExecutionError(message + partial, [...done.txHashes, ...(legError instanceof KivoExecutionError ? legError.txHashes : [])]);
          }
        }
        return done;
      });
      const tone = outcome.status === 'success' ? 'success' : 'pending';
      const message = outcome.status === 'success' ? `${side === 'buy' ? 'Bought' : 'Sold'} ${token.symbol}.`
        : outcome.status === 'refunded' ? 'The route could not be filled and was refunded.' : 'Submitted — the route is still settling.';
      setResult({ tone, message, hashes: outcome.txHashes, chainIds: outcome.chainIds, requestId: outcome.requestId });
      recordTrade({ side, token: tokenInfo, pay: { amount: view.pay.amount, symbol: view.pay.symbol, chainKey: view.pay.chainKey }, receive: { amount: view.receive.amount, symbol: view.receive.symbol, chainKey: view.receive.chainKey }, txHashes: outcome.txHashes, chainIds: outcome.chainIds, requestId: outcome.requestId, status: outcome.status });
      addNotification(outcome.status === 'success' ? 'Trade complete' : 'Trade submitted', `${side === 'buy' ? 'Buy' : 'Sell'} ${token.symbol}: ${view.pay.amount} ${view.pay.symbol}`);
    } catch (error) {
      const hashes = error instanceof KivoExecutionError ? error.txHashes : [];
      const message = error instanceof Error ? error.message : 'Trade failed.';
      setResult({ tone: 'error', message, hashes, chainIds: [], requestId: null });
      if (hashes.length) recordTrade({ side, token: tokenInfo, pay: { amount: view.pay.amount, symbol: view.pay.symbol, chainKey: view.pay.chainKey }, receive: { amount: view.receive.amount, symbol: view.receive.symbol, chainKey: view.receive.chainKey }, txHashes: hashes, chainIds: [], requestId: null, status: 'failed', error: message });
    } finally {
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
  const ready = quoteState === 'ready' && Boolean(view) && !expired && !view?.unsupportedReason && walletKind(wallet) === 'evm-local';
  const tradeChain: ChainKey | null = token?.chainKey ?? (selectedToken?.chainKey !== 'near' ? selectedToken?.chainKey ?? null : null);
  const receiveSymbol = side === 'buy' ? token?.symbol ?? '' : token && TOKEN_ADDRESSES.USDC?.[token.chainKey] ? 'USDC' : token ? nativeSymbol(token.chainKey) : '';
  const hint = !wallet ? 'Create or import a Kivo wallet on this phone to trade.'
    : amountProblem ?? (parsed == null ? `Enter an amount to ${side} ${token?.symbol ?? ''}`
      : quoteState === 'loading' ? 'Finding the best route…'
      : quoteState === 'error' ? quoteError
      : expired ? 'Quote expired — tap Refresh.'
      : view?.unsupportedReason ? view.unsupportedReason
      : quoteState === 'ready' ? `Review and ${side} ${token?.symbol ?? ''}` : '');
  const hintIsError = Boolean(amountProblem) || quoteState === 'error' || Boolean(view?.unsupportedReason);
  const pressSide = (target: TradeSide) => {
    if (target !== side) { setSide(target); return; }
    if (ready) setReviewOpen(true);
    else if (expired) fetchQuote();
  };
  const disabledInput = !wallet || !token;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={styles.cashRow}>
        <Text style={styles.cashLabel}>Portfolio</Text>
        <Text style={styles.cashValue}>{!wallet ? '—' : cashTotal == null ? '…' : settings.hideBalances ? '••••' : formatUsd(cashTotal)}</Text>
      </View>
      <View style={styles.toolbar}>
        <Pressable onPress={() => { if (cash) setChainOpen(true); }} style={[styles.pill, styles.grow]}>
          <Text style={styles.pillMuted} numberOfLines={1}>Trading on <Text style={styles.pillStrong}>{tradeChain ? chainLabel(tradeChain) : '—'}</Text>{cash ? '  ›' : ''}</Text>
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
                <Pressable key={pct} disabled={available == null || available <= 0} onPress={() => choosePreset(pct)} style={[styles.preset, (available == null || available <= 0) && styles.disabled]}>
                  <Text style={styles.presetText}>{pct === 100 ? 'MAX' : `${pct}%`}</Text>
                </Pressable>
              ))}
              <Pressable disabled={disabledInput} onPress={() => amountRef.current?.focus()} style={[styles.preset, styles.presetCustom, disabledInput && styles.disabled]}>
                <Text style={[styles.presetText, styles.presetCustomText]}>Custom</Text>
              </Pressable>
            </View>

            <View style={styles.cardsRow}>
            <View style={styles.card}>
              <Text style={styles.cardLabel}>YOU PAY</Text>
              <View style={styles.cardRow}>
                <AssetChip symbol={side === 'buy' ? 'USDC' : token!.symbol} uri={side === 'buy' ? null : token!.imageUrl} />
                <TextInput ref={amountRef} editable={!disabledInput} value={amount} onChangeText={value => setAmount(value.replace(',', '.'))} keyboardType="decimal-pad" placeholder="0" placeholderTextColor={kivoTheme.colors.textMuted} style={styles.amountInput} accessibilityLabel={side === 'buy' ? 'USDC to spend' : `${token!.symbol} to sell`} />
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
              <Text style={styles.feeStrong}>{view ? `Fee ${feePct != null ? feePct.toFixed(1) + '%' : formatUsd(view.totalFeeUsd)}` : 'Kivo fee 0.5%'}</Text>
              <Text style={[styles.small, styles.flex]}>{'  ·  Gas free'}{view?.etaSeconds != null ? `  ·  ETA ${view.etaSeconds < 60 ? `~${view.etaSeconds}s` : `~${Math.round(view.etaSeconds / 60)} min`}` : '  ·  ETA ~1 min'}</Text>
              {view ? <Pressable onPress={() => setShowDetails(value => !value)} hitSlop={8}><Text style={styles.detailsLink}>{showDetails ? 'Hide' : 'Details'}</Text></Pressable> : null}
            </View>
            {view && showDetails && (
              <View style={styles.details}>
                <QuoteRow label="Minimum received" value={view.minimumReceived ? `${formatAmount(Number(view.minimumReceived))} ${view.receive.symbol}` : 'Not provided by route'} />
                <QuoteRow label="Price impact" value={view.priceImpactPct == null ? '—' : `${view.priceImpactPct.toFixed(2)}%`} danger={view.priceImpactPct != null && Math.abs(view.priceImpactPct) >= 5} />
                <QuoteRow label="Route fees" value={formatUsd(view.totalFeeUsd)} />
                <QuoteRow label="Network gas" value="Paid by Kivo" />
                <QuoteRow label="Max slippage" value={view.slippagePct == null ? 'Auto' : `${view.slippagePct}%`} />
                <QuoteRow label="Route" value={view.routeLabel} />
                <QuoteRow label="You sign" value={view.transactionCount > 1 ? `Once (${view.transactionCount} steps batched)` : 'Once'} />
                <QuoteRow label="Quote" value={expired ? 'Expired' : `Refreshes in ${Math.max(0, Math.ceil((view.expiresAt - now) / 1000))}s`} />
              </View>
            )}
            {side === 'buy' && cash && !cash.some(r => r.status === 'ok' && r.balance.amount > 0) && <Text style={styles.note}>No USDC found on supported chains. Receive USDC to {shortAddress(address)} to buy.</Text>}
            <Text style={styles.note}>Gasless: you only need USDC — Kivo covers network gas. Your wallet {address ? shortAddress(address) : ''} stays on this phone, and every route is checked by Kivo's transaction firewall before you sign.</Text>
          </>
        )}

      <Modal visible={chainOpen} transparent animationType="slide" onRequestClose={() => setChainOpen(false)}>
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
      </Modal>

      <Modal visible={settingsOpen} transparent animationType="slide" onRequestClose={() => setSettingsOpen(false)}>
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
      </Modal>
      <Modal visible={reviewOpen} transparent animationType="slide" onRequestClose={closeReview}>
        <View style={styles.sheetBackdrop}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>Confirm {side}</Text>
            {view && <>
              <View style={styles.summary}>
                <View style={styles.flex}><Text style={styles.small}>You pay</Text><Text style={styles.summaryValue}>{view.pay.amount} {view.pay.symbol}</Text><Text style={styles.small}>{CHAIN_LABEL[view.pay.chainKey]}</Text></View>
                <Text style={styles.chevron}>›</Text>
                <View style={[styles.flex, styles.right]}><Text style={styles.small}>Minimum received</Text><Text style={styles.summaryValue}>{view.minimumReceived ? formatAmount(Number(view.minimumReceived)) : '—'} {view.receive.symbol}</Text><Text style={styles.small}>{CHAIN_LABEL[view.receive.chainKey]}</Text></View>
              </View>
              <QuoteRow label="Route fees" value={formatUsd(view.totalFeeUsd)} />
              <QuoteRow label="Network gas" value="Paid by Kivo" />
              <QuoteRow label="Signing wallet" value={shortAddress(address)} />
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
            {result && <Text style={result.tone === 'error' ? styles.error : styles.okText}>{result.message}</Text>}
            {result?.hashes.map((hash, index) => {
              const url = explorerTxUrl(result.chainIds[index] ?? result.chainIds[0] ?? 0, hash);
              return <Pressable key={hash} disabled={!url} onPress={() => url && Linking.openURL(url)}><Text style={styles.link}>Transaction {index + 1}: {shortAddress(hash, 10, 6)}</Text></Pressable>;
            })}
            {result?.requestId && <Pressable onPress={() => Linking.openURL(relayRequestUrl(result.requestId!))}><Text style={styles.link}>Route status</Text></Pressable>}
            {result ? (
              <Pressable onPress={closeReview} style={styles.secondaryButton}><Text style={styles.secondaryText}>Close</Text></Pressable>
            ) : (
              <>
                <Pressable disabled={running || !preflight?.ok} onPress={execute} style={[styles.primaryButton, side === 'sell' && styles.sellButton, (running || !preflight?.ok) && styles.disabled]}>
                  <Text style={styles.primaryText}>{running ? 'Working…' : 'Confirm and sign'}</Text>
                </Pressable>
                {!running && <Pressable onPress={closeReview} style={styles.ghostButton}><Text style={styles.secondaryText}>Cancel</Text></Pressable>}
              </>
            )}
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

function AssetChip({ symbol, uri }: { symbol: string; uri?: string | null }) {
  return (
    <View style={styles.chipAsset}>
      {uri ? <Image source={{ uri }} style={styles.chipIcon} /> : <View style={styles.chipIcon}><Text style={styles.chipLetter}>{symbol.slice(0, 1).toUpperCase()}</Text></View>}
      <Text style={styles.chipSymbol}>{symbol}</Text>
    </View>
  );
}

function QuoteRow({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return <View style={styles.quoteRow}><Text style={styles.quoteLabel}>{label}</Text><Text style={[styles.quoteValue, danger && { color: kivoTheme.colors.danger }]}>{value}</Text></View>;
}

const c = {
  background: '#1B1B1E',
  backgroundDeep: '#151518',
  surface: '#242428',
  surfaceRaised: '#2B2B2F',
  border: '#3A3A3F',
  text: '#F4F4F5',
  textMuted: '#85858C',
  cream: '#F4F4F5',
  accent: '#D8D8DD',
  success: '#2FD67B',
  danger: '#FF4F46',
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background },
  content: { padding: 16, paddingBottom: 48 },
  flex: { flex: 1 },
  right: { alignItems: 'flex-end' },
  muted: { color: c.textMuted, fontSize: 11.5 },
  small: { color: c.textMuted, fontSize: 10.5 },
  note: { color: c.textMuted, fontSize: 11, lineHeight: 16, marginTop: 8 },
  cashRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  cashLabel: { color: c.textMuted, fontSize: 11, fontWeight: '600' },
  cashValue: { color: c.text, fontSize: 15, fontWeight: '800' },
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
  pill: { height: 26, paddingHorizontal: 10, borderRadius: 999, backgroundColor: c.surface, justifyContent: 'center' },
  grow: { flex: 1 },
  pillMuted: { color: c.textMuted, fontSize: 10.5 },
  pillStrong: { color: c.text, fontWeight: '700', fontSize: 10.5 },
  round: { width: 26, height: 26, borderRadius: 13, backgroundColor: c.surface, alignItems: 'center', justifyContent: 'center' },
  gear: { color: c.textMuted, fontSize: 15 },
  tokenRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8 },
  tokenIcon: { width: 44, height: 44, borderRadius: 22, backgroundColor: c.surfaceRaised, alignItems: 'center', justifyContent: 'center' },
  tokenLetter: { color: c.text, fontWeight: '800', fontSize: 16 },
  tokenSymbol: { color: c.text, fontWeight: '800', fontSize: 16 },
  tokenPrice: { color: c.text, fontWeight: '800', fontSize: 15 },
  historyButton: { width: 32, height: 32, borderRadius: 16, backgroundColor: c.surface, alignItems: 'center', justifyContent: 'center', marginLeft: 4 },
  chevron: { color: c.textMuted, fontSize: 22 },
  notice: { marginTop: 8, padding: 12, borderRadius: 14, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border },
  noticeText: { color: c.textMuted, fontSize: 11.5, lineHeight: 17 },
  sides: { flexDirection: 'row', gap: 8, marginTop: 10, marginBottom: 2 },
  buy: { flex: 1, height: 44, borderRadius: 999, backgroundColor: '#2FD67B', alignItems: 'center', justifyContent: 'center' },
  buyText: { color: '#151518', fontWeight: '700', fontSize: 13.5 },
  sell: { flex: 1, height: 44, borderRadius: 999, borderWidth: 1, borderColor: '#FF4F46', alignItems: 'center', justifyContent: 'center', backgroundColor: c.surface },
  sellReady: { backgroundColor: '#FF4F46' },
  sellText: { color: '#FF4F46', fontWeight: '700', fontSize: 13.5 },
  sellTextReady: { color: '#fff' },
  inactive: { opacity: 0.42 },
  hint: { color: c.textMuted, fontSize: 11, textAlign: 'center', marginTop: 5, marginBottom: 4 },
  hintError: { color: c.danger },
  refresh: { alignSelf: 'center', marginTop: 6, paddingHorizontal: 12, height: 28, borderRadius: 14, backgroundColor: c.surfaceRaised, justifyContent: 'center' },
  refreshText: { color: c.text, fontWeight: '700', fontSize: 10.5 },
  presets: { flexDirection: 'row', gap: 6, marginTop: 8 },
  preset: { flex: 1, height: 34, borderRadius: 999, alignItems: 'center', justifyContent: 'center', backgroundColor: c.surface },
  presetCustom: { flex: 1, backgroundColor: c.surface },
  presetText: { color: c.text, fontWeight: '600', fontSize: 11 },
  presetCustomText: { color: c.text },
  cardsRow: { flexDirection: 'row', gap: 8, marginTop: 8 },
  card: { flex: 1, minWidth: 0, padding: 12, borderRadius: 14, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface, gap: 6 },
  cardLabel: { color: c.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 0.6 },
  cardRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 6 },
  chipAsset: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingLeft: 3, paddingRight: 8, height: 26, borderRadius: 999, backgroundColor: c.surfaceRaised },
  chipIcon: { width: 20, height: 20, borderRadius: 10, backgroundColor: c.background, alignItems: 'center', justifyContent: 'center' },
  chipLetter: { color: c.text, fontWeight: '800', fontSize: 9 },
  chipSymbol: { color: c.text, fontWeight: '700', fontSize: 11 },
  amountInput: { flex: 1, minWidth: 40, color: c.text, fontSize: 16, fontWeight: '600', textAlign: 'right', paddingVertical: 0 },
  receive: { flex: 1, minWidth: 40, color: c.text, fontSize: 16, fontWeight: '600', textAlign: 'right' },
  avail: { color: c.textMuted, fontSize: 10, textAlign: 'right', minHeight: 12 },
  feeRow: { flexDirection: 'row', alignItems: 'center', marginTop: 8, paddingHorizontal: 12, height: 36, borderRadius: 999, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: c.textMuted, marginRight: 6 },
  dotLive: { backgroundColor: '#2FD67B' },
  feeStrong: { color: c.text, fontWeight: '700', fontSize: 11 },
  detailsLink: { color: c.text, fontWeight: '600', fontSize: 10.5 },
  details: { marginTop: 6, paddingHorizontal: 12, paddingVertical: 2, borderRadius: 12, backgroundColor: c.surface },
  quoteRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 7, borderTopWidth: 1, borderTopColor: c.border },
  quoteLabel: { color: c.textMuted, fontSize: 10.5 },
  quoteValue: { color: c.text, fontSize: 10.5, fontWeight: '700', flexShrink: 1, textAlign: 'right', marginLeft: 10 },
  payRow: { flexDirection: 'row', alignItems: 'center', padding: 11, borderRadius: 12, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, marginBottom: 6 },
  payRowSelected: { borderColor: '#2FD67B' },
  payName: { flex: 1, color: c.text, fontWeight: '700', fontSize: 11.5 },
  payAmount: { color: c.text, fontWeight: '800', fontSize: 11.5 },
  check: { color: '#2FD67B', marginLeft: 6, fontWeight: '800', fontSize: 10.5 },
  slippageRow: { flexDirection: 'row', gap: 6, marginTop: 10 },
  chip: { flex: 1, height: 34, borderRadius: 999, backgroundColor: c.surface, alignItems: 'center', justifyContent: 'center' },
  chipActive: { backgroundColor: c.text },
  chipText: { color: c.text, fontWeight: '700', fontSize: 11 },
  chipTextActive: { color: c.background },
  error: { color: c.danger, fontSize: 11, lineHeight: 16, marginTop: 5 },
  okText: { color: c.success, fontSize: 11, lineHeight: 16, marginTop: 8 },
  primaryButton: { marginTop: 12, height: 48, borderRadius: 999, backgroundColor: '#2FD67B', alignItems: 'center', justifyContent: 'center' },
  sellButton: { backgroundColor: '#FF4F46' },
  primaryText: { color: '#151518', fontWeight: '800', fontSize: 13, textTransform: 'capitalize' },
  secondaryButton: { marginTop: 10, height: 42, borderRadius: 999, backgroundColor: c.surfaceRaised, alignItems: 'center', justifyContent: 'center' },
  ghostButton: { marginTop: 6, height: 36, alignItems: 'center', justifyContent: 'center' },
  secondaryText: { color: c.text, fontWeight: '700', fontSize: 12 },
  disabled: { opacity: 0.45 },
  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: c.background, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 18, paddingBottom: 28, borderWidth: 1, borderColor: c.border, maxHeight: '92%' },
  settingsSheet: { paddingBottom: 22 },
  settingsHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  activeBadge: { backgroundColor: c.surfaceRaised, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 5 },
  activeBadgeText: { color: c.text, fontSize: 10, fontWeight: '700' },
  settingsLabel: { color: c.textMuted, fontSize: 11, fontWeight: '700', marginBottom: 7 },
  customRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 7 },
  customChip: { flex: 0, paddingHorizontal: 14 },
  customInput: { flex: 1, height: 34, borderRadius: 17, backgroundColor: c.surface, color: c.text, paddingHorizontal: 12, textAlign: 'right' },
  customPercent: { color: c.text, fontWeight: '700', fontSize: 11 },
  warning: { color: c.danger, fontSize: 10.5, marginTop: 7 },
  minimumReceived: { color: c.textMuted, fontSize: 10, marginTop: 12, marginBottom: 14 },
  saveButton: { backgroundColor: '#2FD67B', borderRadius: 12, paddingVertical: 13, alignItems: 'center' },
  saveButtonText: { color: '#151518', fontSize: 13, fontWeight: '800' },
  settingsHint: { color: c.textMuted, fontSize: 9.5, textAlign: 'center', marginTop: 8 },
  sheetTitle: { color: c.text, fontSize: 17, fontWeight: '800', marginBottom: 10, textTransform: 'capitalize' },
  summary: { flexDirection: 'row', alignItems: 'center', padding: 12, borderRadius: 14, backgroundColor: c.backgroundDeep, marginBottom: 7 },
  summaryValue: { color: c.text, fontWeight: '800', fontSize: 14, marginVertical: 2 },
  timeline: { marginTop: 10, gap: 5 },
  stage: { color: c.textMuted, fontSize: 11.5, fontWeight: '700' },
  stageActive: { color: c.text },
  stageDone: { color: c.success },
  stageFailed: { color: c.danger },
  link: { color: c.text, fontWeight: '700', fontSize: 11, marginTop: 6 },
});