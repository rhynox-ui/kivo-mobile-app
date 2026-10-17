import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { kivoTheme } from '../theme/kivoTheme';
import { parseUnits } from 'viem';
import { NEAR_USDC, NEAR_USDC_DECIMALS } from '@kivo/trading/core/chainData';
import { withNearCash } from '@kivo/trading/core/nearCashTotal';
import { fetchNearTokenBalance } from '@kivo/trading/core/nearTrade';
import { nearCashMoveChains, nearCashMoveRequest, nearUsdcDepositCall } from '@kivo/trading/core/nearCashMoves';
import { fetchOneClickTokens, requestOneClickQuote, submitOneClickDepositTx } from '@kivo/trading/core/oneClick';
import { fundOneClickQuote } from '@kivo/trading/core/oneClickDeposits';
import { oneClickSwapStore } from '@kivo/trading/wallet/oneClickSwapStore';
import { nearView } from '@kivo/trading/core/nearRpc';

import { getWalletSession, loadWalletSession, requireNear, subscribeToWallet, withDeviceAccounts, type WalletSession } from '../state/walletStore';
import { useSettings } from '../state/settingsStore';
import { addNotification } from '../state/notificationStore';
import { markOwnAction } from '../wallet/depositWatcher';
import { CHAIN_LABEL, MAINNET_CHAIN_IDS, NATIVE_SYMBOL, type ChainKey } from '@kivo/trading/core/chainData';
import { transactionLink } from '@kivo/trading/kivo/execute';
import { clearCashBalanceCache, fetchCashBalances, totalCashUsd, CASH_CHAINS, cashAssetSymbol, type CashBalanceRow } from '@kivo/trading/kivo/balances';
import { isValidRecipientAddress, withdrawUsdc } from '@kivo/trading/kivo/cash';
import { fetchGaslessStatus, type GaslessStatus } from '@kivo/trading/kivo/gasless';
import { formatAmount, formatUsd, shortAddress } from '@kivo/trading/kivo/tokens';
import { NetworkIcon } from '../wallet/NetworkIcon';
import QRCode from 'react-native-qrcode-svg';
import { normalizeAmountInput } from '../utils/amountInput';
import { KivoModal } from '../components/KivoModal';
import Clipboard from '@react-native-clipboard/clipboard';

type Sheet = null | 'deposit' | 'withdraw';
type DepositNetwork = ChainKey | 'near';
type WithdrawNetwork = ChainKey | 'near';
type NearBalanceState = {status: 'loading' | 'ok' | 'error' | 'not-available'; amount: number};

const DEPOSIT_CHAINS: DepositNetwork[] = [...new Set<DepositNetwork>([...CASH_CHAINS, 'near'])];


/** The real coin on each network: USDG on Robinhood, USDC everywhere else. */
function cashCoin(network: DepositNetwork | null | undefined): string {
  return network && network !== 'near' ? cashAssetSymbol(network) : 'USDC';
}

/** What a deposit on this network may be: its cash coin, plus the network's own coin where Kivo can spend it. */
function depositCoins(network: DepositNetwork): string {
  const cash = cashCoin(network);
  if (network === 'near') return cash;
  const native = NATIVE_SYMBOL[network];
  return native && native !== cash ? `${cash} or ${native}` : cash;
}

function networkLabel(network: DepositNetwork): string {
  return network === 'near' ? 'NEAR' : CHAIN_LABEL[network];
}

function networkAddress(wallet: WalletSession, network: DepositNetwork): string {
  if (network === 'solana') return wallet.solanaAddress ?? '';
  if (network === 'near') return wallet.nearAddress ?? '';
  return wallet.address;
}

function NetworkBadge({ network }: { network: DepositNetwork }) {
  return <NetworkIcon chainKey={network} size={22} />;
}

/**
 * Kivo mobile cash, matching Mango Pro's wallet flow:
 * one wallet, real USDC balances, network-specific deposit addresses,
 * and an explicit withdrawal review before anything is broadcast.
 */
export function WalletSummaryScreen({
  onBack,
  onTrade,
  initialAction,
}: {
  onBack?: () => void;
  onTrade?: () => void;
  initialAction?: 'deposit' | 'withdraw';
}) {
  const [wallet, setWallet] = useState<WalletSession | null>(getWalletSession());
  const [rows, setRows] = useState<CashBalanceRow[] | null>(null);
  const [sheet, setSheet] = useState<Sheet>(initialAction ?? null);
  const [gasless, setGasless] = useState<GaslessStatus | null>(null);
  const [nearCash, setNearCash] = useState<NearBalanceState>({status: 'loading', amount: 0});
  const nearBalance = nearCash.status === 'ok' || nearCash.status === 'not-available' ? nearCash.amount : null;
  const settings = useSettings();

  const load = () => {
    if (!wallet) return;
    setRows(null);
    fetchCashBalances(wallet.address, CASH_CHAINS, wallet.solanaAddress).then(setRows).catch(() => setRows((CASH_CHAINS).map((chainKey): CashBalanceRow => ({chainKey: chainKey as CashBalanceRow['chainKey'], status: 'error', error: 'Balance unavailable.'}))));
    if (wallet.nearAddress) {
      setNearCash({status: 'loading', amount: 0});
      fetchNearTokenBalance(NEAR_USDC, wallet.nearAddress)
        .then(v => setNearCash({status: 'ok', amount: Number(v) / 10 ** NEAR_USDC_DECIMALS}))
        .catch(() => setNearCash({status: 'error', amount: 0}));
    } else {
      setNearCash({status: 'not-available', amount: 0});
    }
  };

  useEffect(() => {
    const unsub = subscribeToWallet(setWallet);
    loadWalletSession().catch(() => {});
    fetchGaslessStatus().then(setGasless);
    return unsub;
  }, []);

  useEffect(() => {
    if (!wallet) return;
    setRows(null);
    fetchCashBalances(wallet.address, CASH_CHAINS, wallet.solanaAddress).then(setRows).catch(() => setRows((CASH_CHAINS).map((chainKey): CashBalanceRow => ({chainKey: chainKey as CashBalanceRow['chainKey'], status: 'error', error: 'Balance unavailable.'}))));
    if (wallet.nearAddress) {
      setNearCash({status: 'loading', amount: 0});
      fetchNearTokenBalance(NEAR_USDC, wallet.nearAddress)
        .then(v => setNearCash({status: 'ok', amount: Number(v) / 10 ** NEAR_USDC_DECIMALS}))
        .catch(() => setNearCash({status: 'error', amount: 0}));
    } else {
      setNearCash({status: 'not-available', amount: 0});
    }
  }, [wallet?.address]);

  const total = rows ? totalCashUsd(rows) : null;
  const totalWithNear = withNearCash(total, nearBalance);
  const displayTotal = totalWithNear?.total ?? null;
  const funded = rows?.filter(r => r.status === 'ok' && r.balance.amount > 0) ?? [];
  const failedRows = rows?.filter(r => r.status === 'error') ?? [];
  const failedNetworkNames = [
    ...failedRows.map(r => CHAIN_LABEL[r.chainKey]),
    ...(nearCash.status === 'error' && wallet?.nearAddress ? ['NEAR'] : []),
  ];
  const mask = (value: string) => (settings.hideBalances ? '••••' : value);

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        {onBack && <Pressable onPress={onBack} hitSlop={10}><Text style={styles.back}>‹</Text></Pressable>}
        <Text style={styles.eyebrow}>KIVO WALLET</Text>
      </View>

      {!wallet ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>No wallet on this phone</Text>
          <Text style={styles.note}>Create or import a Kivo wallet to hold USDC and trade.</Text>
        </View>
      ) : (
        <>
          <Text style={styles.balance}>{displayTotal == null ? '…' : mask(formatUsd(displayTotal))}</Text>
          <Text style={styles.sub}>
            {totalWithNear == null
              ? 'Reading USDC on supported networks…'
              : totalWithNear.complete
                ? 'Total cash · USDC across supported networks'
                : 'Some networks did not respond — total may be incomplete'}
          </Text>

          <View style={styles.actions}>
            <Action glyph="↓" label="Deposit" onPress={() => setSheet('deposit')} />
            <Action glyph="↑" label="Withdraw" onPress={() => setSheet('withdraw')} />
            {onTrade && <Action glyph="⇄" label="Trade" onPress={onTrade} />}
            <Action glyph="⟳" label="Refresh" onPress={load} />
          </View>

          <View style={[styles.gasBanner, gasless && !gasless.available && styles.gasBannerOff]}>
            <Text style={styles.gasTitle}>
              {gasless == null ? 'Checking gasless trading…' : gasless.available ? '⛽  Gasless is on' : '⛽  Gasless is off'}
            </Text>
            <Text style={styles.note}>
              {gasless?.available === false
                ? gasless.reason
                : 'Trades and withdrawals need only USDC. Kivo pays the network gas.'}
            </Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Cash by network</Text>
            {rows == null ? (
              <ActivityIndicator color={kivoTheme.colors.accent} style={{ marginTop: 12 }} />
            ) : failedRows.length > 0 && funded.length === 0 && nearCash.status !== 'loading' && (nearBalance === null || nearBalance === 0) ? (
              <Text style={styles.note}>Balances could not be read right now ({failedNetworkNames.join(', ')}). Pull to refresh or try again shortly.</Text>
            ) : funded.length === 0 && failedRows.length === 0 && nearBalance === 0 ? (
              <Text style={styles.note}>No USDC yet. Tap Deposit and send USDC on any supported network.</Text>
            ) : (
              <>
              {nearCash.status === 'loading' && wallet.nearAddress && <Text style={styles.note}>Checking NEAR USDC balance…</Text>}
              {nearCash.status === 'error' && wallet.nearAddress && <Text style={styles.note}>NEAR USDC balance could not be read; the total excludes NEAR until refresh.</Text>}
              {nearBalance !== null && nearBalance > 0 && wallet.nearAddress && <View key="near" style={styles.row}><View style={styles.rowLeft}><NetworkIcon chainKey="near" size={22} /><Text style={styles.rowName}>USDC · NEAR</Text></View><Text style={styles.rowValue}>{mask(formatAmount(nearBalance, 2))}</Text></View>}
              {funded.map(row => (
                <View key={row.chainKey} style={styles.row}>
                  <View style={styles.rowLeft}>
                    <NetworkBadge network={row.chainKey} />
                    <Text style={styles.rowName}>{cashCoin(row.chainKey)} · {CHAIN_LABEL[row.chainKey]}</Text>
                  </View>
                  <Text style={styles.rowValue}>{row.status === 'ok' ? mask(formatAmount(row.balance.amount, 2)) : 'Unavailable'}</Text>
                </View>
              ))}
              {failedRows.length > 0 && <Text style={styles.note}>Not included (could not be read): {failedNetworkNames.join(', ')}.</Text>}
              </>
            )}
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Device wallet</Text>
            <Text style={styles.address} selectable>{shortAddress(wallet.address, 10, 8)}</Text>
            <Text style={styles.note}>Your keys stay in this phone’s secure storage. Kivo never displays or uploads your recovery phrase.</Text>
          </View>
        </>
      )}

      {wallet && (
        <DepositSheet
          visible={sheet === 'deposit'}
          wallet={wallet}
          onClose={() => setSheet(null)}
        />
      )}
      {wallet && (
        <WithdrawSheet
          visible={sheet === 'withdraw'}
          rows={rows}
          nearBalance={nearBalance ?? 0}
          gasless={gasless}
          wallet={wallet}
          onClose={() => setSheet(null)}
          onDone={() => { setSheet(null); load(); }}
        />
      )}
    </ScrollView>
  );
}

function Action({ glyph, label, onPress }: { glyph: string; label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.action}>
      <View style={styles.actionIcon}><Text style={styles.actionGlyph}>{glyph}</Text></View>
      <Text style={styles.actionLabel}>{label}</Text>
    </Pressable>
  );
}

function DepositSheet({
  visible,
  wallet,
  onClose,
}: {
  visible: boolean;
  wallet: WalletSession;
  onClose: () => void;
}) {
  const [network, setNetwork] = useState<DepositNetwork | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!visible) {
      setNetwork(null);
    }
  }, [visible]);

  const selected = network;
  const address = selected ? networkAddress(wallet, selected) : '';


  return (
    <KivoModal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          {!selected ? (
            <>
              <View style={styles.sheetHeader}>
                <Text style={styles.sheetTitle}>Deposit</Text>
                <Pressable onPress={onClose}><Text style={styles.ghostText}>Close</Text></Pressable>
              </View>

              <Text style={styles.note}>Choose the network you want to receive on (USDC, or USDG on Robinhood Chain).</Text>

              <ScrollView
                style={styles.networkList}
                contentContainerStyle={styles.depositNetworkContent}
                nestedScrollEnabled
                showsVerticalScrollIndicator
                persistentScrollbar
                bounces={false}
              >
                {DEPOSIT_CHAINS.map(chain => (
                  <Pressable key={chain} onPress={() => setNetwork(chain)} style={styles.networkRow}>
                    <View style={styles.rowLeft}>
                      <NetworkIcon chainKey={chain} size={22} />
                      <Text style={styles.networkRowText}>{networkLabel(chain)}</Text>
                    </View>
                    <Text style={styles.chevron}>›</Text>
                  </Pressable>
                ))}

              </ScrollView>
            </>
          ) : (
            <>
              <View style={styles.sheetHeader}>
                <Pressable onPress={() => setNetwork(null)} hitSlop={10}>
                  <Text style={styles.backText}>‹ Back</Text>
                </Pressable>
                <Text style={styles.sheetTitle}>{networkLabel(selected)}</Text>
                <View style={styles.headerSpacer} />
              </View>

              <Text style={styles.addressSectionTitle}>Your {networkLabel(selected)} address</Text>
              {address ? (
                <View style={styles.qrWrap}>
                  <QRCode value={address} size={210} backgroundColor="#ffffff" color="#000000" ecl="H" quietZone={8} />
                </View>
              ) : null}
              <Text style={styles.addressFull} selectable numberOfLines={1} ellipsizeMode="middle">
                {address || 'Address unavailable'}
              </Text>
              <View style={styles.addressActions}>
                <Pressable disabled={!address} onPress={() => { Clipboard.setString(address); setCopied(true); setTimeout(() => setCopied(false), 2000); }} style={[styles.copyButton, !address && styles.disabled]} accessibilityLabel="Copy address">
                  <Text style={styles.copyButtonText}>{copied ? 'Copied ✓' : 'Copy address'}</Text>
                </Pressable>
                <Pressable disabled={!address} onPress={() => Share.share({ message: address })} style={[styles.shareButton, !address && styles.disabled]}>
                  <Text style={styles.shareButtonText}>Share</Text>
                </Pressable>
              </View>

              <Text style={styles.note}>
                {selected === 'solana'
                  ? "A separate address — Solana isn't an EVM chain, so it can't share the address other networks use."
                  : selected === 'near'
                    ? 'Your NEAR account, from the same recovery phrase — it also works in compatible NEAR wallets.'
                    : 'The same EVM address also works on the other supported EVM networks.'}
              </Text>

              <Text style={styles.warn}>
                Send {depositCoins(selected)} on {networkLabel(selected)} only. Assets sent on another network may be lost.
              </Text>

            </>
          )}
        </Pressable>
      </Pressable>
    </KivoModal>
  );
}

function WithdrawSheet({
  visible,
  rows,
  nearBalance,
  gasless,
  wallet,
  onClose,
  onDone,
}: {
  visible: boolean;
  rows: CashBalanceRow[] | null;
  nearBalance: number;
  gasless: GaslessStatus | null;
  wallet: WalletSession;
  onClose: () => void;
  onDone: () => void;
}) {
  const [chain, setChain] = useState<WithdrawNetwork | null>(null);
  const [destination, setDestination] = useState<ChainKey>('base');
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState(false);
  // Full result screen after a send (success or failure), instead of a small line of text.
  const [showOutcome, setShowOutcome] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string; hash?: string; chainId?: number } | null>(null);

  // Mango parity: the withdrawal picker always shows every supported cash network, not only networks with a positive balance. The selected network then shows its live available balance (including 0), so users can still choose the network before funding it.
  const row = chain && chain !== 'near' ? rows?.find(r => r.chainKey === chain) : null;
  const available = chain === 'near' ? nearBalance : (row?.status === 'ok' ? row.balance.amount : 0);
  const parsed = Number(amount);
  const addressValid = chain ? (chain === 'near' ? isValidRecipientAddress(destination, to.trim()) : isValidRecipientAddress(chain, to.trim())) : false;
  const maxWithdrawable = Math.max(0, available);
  const amountValid = Number.isFinite(parsed) && parsed > 0 && parsed <= maxWithdrawable + 1e-9;
  const sponsorshipNeeded = chain !== 'solana' && chain !== 'near';
  const nearDestinationReady = chain !== 'near' || nearCashMoveChains().includes(destination);
  const sponsorshipReady = !sponsorshipNeeded || gasless?.available === true;
  const canReview = Boolean(chain && addressValid && amountValid && sponsorshipReady && nearDestinationReady && !busy);

  useEffect(() => {
    if (!visible) return;
    setResult(null);
    setReview(false);
    setShowOutcome(false);
    setTo('');
    setAmount('');
    setChain(null);
    const nearChains = nearCashMoveChains();
    setDestination(current => nearChains.includes(current) ? current : (nearChains[0] ?? 'base'));
    // Only when the sheet opens: balances arriving later must not wipe what was typed.
  }, [visible]);

  const problem = !chain
    ? 'Choose a network.'
    : !to
      ? 'Enter the recipient address.'
      : !addressValid
        ? chain === 'solana' ? 'Enter a valid Solana address.' : 'Enter a valid 0x… address.'
        : !amount
          ? 'Enter an amount to withdraw.'
          : !Number.isFinite(parsed) || parsed <= 0
            ? 'Enter an amount greater than zero.'
            : parsed > available + 1e-9
              ? `More than the ${formatAmount(available, 2)} ${cashCoin(chain)} available on ${chain === 'near' ? 'NEAR' : CHAIN_LABEL[chain]}.`
              : sponsorshipNeeded && gasless?.available === false
                ? gasless.reason ?? 'Gasless EVM withdrawals are not configured yet.'
                : null;

  const executeSend = async () => {
    if (!chain || !canReview) return;
    setBusy(true);
    setResult(null);
    try {
      const outcome = await withDeviceAccounts(`Send ${amount} ${cashCoin(chain)}`, async accounts => {
        if (chain !== 'near') return withdrawUsdc(chain, accounts.evm, accounts.solana, to.trim(), amount);
        const tokens = await fetchOneClickTokens();
        const move = nearCashMoveRequest({direction: 'from-near', chainKey: destination, amountBaseUnits: parseUnits(amount, NEAR_USDC_DECIMALS).toString(), session: accounts.relay, tokens, dry: false, recipient: to.trim()});
        const response = await requestOneClickQuote(move.request);
        const record = await fundOneClickQuote({
          response, expected: move.expected, originChainKey: 'near', originSymbol: 'USDC', originDecimals: NEAR_USDC_DECIMALS,
          fromAddress: requireNear(accounts.near).address, store: oneClickSwapStore,
          submitDepositTx: (txHash, depositAddress) => submitOneClickDepositTx(txHash, depositAddress),
          send: async (depositAddress, sendAmount) => {
            const call = await nearUsdcDepositCall(depositAddress, parseUnits(sendAmount, NEAR_USDC_DECIMALS), nearView);
            const [sent] = await import('@kivo/trading/core/nearSigning').then(m => m.sendSponsoredNearCalls(accounts.relay, [call]));
            return sent.hash;
          },
        });
        return {hash: record.depositTxHash || undefined};
      });
      clearCashBalanceCache();
      setResult({
        ok: true,
        // A NEAR withdrawal is delivered by NEAR Intents after the deposit lands; it is not "sent" yet.
        message: chain === 'near' ? `Submitted: ${amount} USDC from NEAR to ${shortAddress(to.trim())} on ${CHAIN_LABEL[destination]}. NEAR Intents delivers it in a few minutes.` : `Sent ${amount} ${cashCoin(chain)} on ${CHAIN_LABEL[chain]}.`,
        hash: outcome.hash,
        chainId: chain === 'near' ? undefined : MAINNET_CHAIN_IDS[chain as ChainKey],
      });
      addNotification(chain === 'near' ? 'Withdrawal submitted' : 'Withdrawal sent', `${amount} ${cashCoin(chain)} to ${shortAddress(to.trim())}`);
      setAmount('');
      setTo('');
      setReview(false);
      setShowOutcome(true);
      onDone();
    } catch (error) {
      setResult({ ok: false, message: error instanceof Error ? error.message : 'Withdrawal failed. Nothing was sent.' });
      setShowOutcome(true);
    } finally {
      setBusy(false);
    }
  };

  // Final check in Kivo's own style (was a system Alert): the review card already shows the details.
  const [confirming, setConfirming] = useState(false);
  const confirmSend = () => {
    if (!canReview || !chain) return;
    setConfirming(true);
  };

  return (
    <KivoModal visible={visible} transparent animationType="slide" onRequestClose={() => { if (!busy) onClose(); }}>
      <KeyboardAvoidingView style={styles.flex} behavior="padding">
        <Pressable style={styles.backdrop} onPress={() => { if (!busy) onClose(); }}>
          <Pressable style={styles.sheet} onPress={() => {}}>
            {showOutcome && result ? (
              <View style={styles.outcome}>
                <View style={[styles.outcomeIcon, result.ok ? styles.outcomeIconOk : styles.outcomeIconFail]}>
                  <Text style={styles.outcomeIconText}>{result.ok ? '✓' : '✕'}</Text>
                </View>
                <Text style={styles.outcomeTitle}>{result.ok ? (chain === 'near' ? 'Withdrawal submitted' : 'Withdrawal sent') : 'Withdrawal failed'}</Text>
                <Text style={styles.outcomeBody}>{result.message}</Text>
                {result.hash ? (
                  <Pressable hitSlop={8} onPress={() => { Linking.openURL(transactionLink(result.hash!, result.chainId)).catch(() => {}); }}>
                    <Text style={styles.outcomeLink}>{shortAddress(result.hash)}  ↗ View on explorer</Text>
                  </Pressable>
                ) : null}
                <Pressable onPress={() => { setShowOutcome(false); setResult(null); onClose(); }} style={[styles.primary, styles.outcomeButton]}><Text style={styles.primaryText}>Done</Text></Pressable>
                {!result.ok ? <Pressable onPress={() => { setShowOutcome(false); setResult(null); }} style={styles.ghost}><Text style={styles.ghostText}>Try again</Text></Pressable> : null}
              </View>
            ) : !review ? (
              <>
                <View style={styles.sheetHeader}>
                  <Text style={styles.sheetTitle}>Withdraw {chain ? cashCoin(chain) : 'cash'}</Text>
                  <Pressable onPress={onClose} disabled={busy}><Text style={styles.ghostText}>Close</Text></Pressable>
                </View>

                <Text style={styles.note}>Choose a network to withdraw from. Your balance is shown for every supported network (USDG on Robinhood Chain, USDC elsewhere).</Text>

                {!chain ? (
                  <ScrollView style={styles.networkList} nestedScrollEnabled showsVerticalScrollIndicator>
                    {!rows && <ActivityIndicator color={kivoTheme.colors.accent} style={{ marginVertical: 12 }} />}
                    {DEPOSIT_CHAINS.map((chainKey: DepositNetwork) => {
                      const balanceRow = rows?.find(r => r.chainKey === chainKey);
                      const balance = chainKey === 'near' ? nearBalance : (balanceRow?.status === 'ok' ? balanceRow.balance.amount : 0);
                      return (
                        <Pressable key={chainKey} onPress={() => { setChain(chainKey); setTo(''); setAmount(''); setResult(null); }} style={styles.networkRow}>
                          <View style={styles.rowLeft}>
                            <NetworkBadge network={chainKey} />
                            <Text style={styles.networkRowText}>{networkLabel(chainKey)}</Text>
                          </View>
                          <Text style={styles.networkRowBalance}>{formatUsd(balance)}</Text>
                        </Pressable>
                      );
                    })}
                  </ScrollView>
                ) : (
                  <>
                    <View style={styles.selectedNetworkCard}>
                      <View style={styles.rowLeft}>
                        <NetworkBadge network={chain} />
                        <View style={{flex:1}}>
                          <Text style={styles.selectedNetworkTitle}>{chain === 'near' ? 'NEAR' : CHAIN_LABEL[chain]}</Text>
                          <Text style={styles.selectedNetworkBalance}>Available · {formatUsd(available)}</Text>
                        </View>
                        <Pressable onPress={() => {setChain(null);setTo('');setAmount('');setResult(null);}} hitSlop={10}>
                          <Text style={styles.changeText}>Change</Text>
                        </Pressable>
                      </View>
                    </View>
                    {chain === 'near' && <>
                      <Text style={styles.label}>Destination network</Text>
                      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{marginTop: 7}}>
                        {nearCashMoveChains().map(target => <Pressable key={target} onPress={() => {setDestination(target);setTo('');setResult(null);}} style={[styles.networkRow, {marginRight: 7, paddingVertical: 9}, destination === target && styles.networkRowActive]}><Text style={styles.networkRowText}>{CHAIN_LABEL[target]}</Text></Pressable>)}
                      </ScrollView>
                    </>}
                    <Text style={styles.label}>Recipient address</Text>
                    <TextInput
                      value={to}
                      onChangeText={setTo}
                      placeholder={chain === 'solana' || (chain === 'near' && destination === 'solana') ? 'Solana address' : '0x…'}
                      placeholderTextColor={kivoTheme.colors.textMuted}
                      autoCapitalize="none"
                      autoCorrect={false}
                      style={styles.input}
                    />

                    <Text style={styles.label}>Amount ({cashCoin(chain)})</Text>
                    <View style={styles.amountRow}>
                      <TextInput
                        value={amount}
                        onChangeText={v => setAmount(normalizeAmountInput(v))}
                        keyboardType="decimal-pad"
                        placeholder="0.00"
                        placeholderTextColor={kivoTheme.colors.textMuted}
                        style={[styles.input, styles.flexInput]}
                      />
                      <Pressable onPress={() => setAmount(String(Math.floor(maxWithdrawable * 1e6) / 1e6))} style={styles.max}>
                        <Text style={styles.maxText}>MAX</Text>
                      </Pressable>
                    </View>

                    <Text style={styles.available}>Available on {chain === 'near' ? 'NEAR' : CHAIN_LABEL[chain]}: {formatUsd(maxWithdrawable)}</Text>
                    {problem && <Text style={styles.warn}>{problem}</Text>}
                    {chain === 'near'
                      ? <Text style={styles.note}>NEAR withdrawals use NEAR Intents. Kivo pays NEAR transaction gas through the existing sponsored call path.</Text>
                      : chain === 'solana'
                        ? <Text style={styles.note}>Solana withdrawals use Kivo’s existing fee-sponsor path when your wallet does not have enough SOL for network fees.</Text>
                        : <Text style={styles.note}>EVM withdrawals require Kivo Relay sponsorship. Kivo never silently switches to a user-paid gas transfer.</Text>}
                    {result && <Text style={result.ok ? styles.ok : styles.warn}>{result.message}</Text>}
                    {result?.hash ? <Pressable hitSlop={8} onPress={() => { Linking.openURL(transactionLink(result.hash!, result.chainId)).catch(() => {}); }}><Text style={styles.ok}>{shortAddress(result.hash)}  ↗ View on explorer</Text></Pressable> : null}

                    <Pressable disabled={!canReview} onPress={() => setReview(true)} style={[styles.primary, !canReview && styles.disabled]}>
                      <Text style={styles.primaryText}>Review withdrawal</Text>
                    </Pressable>
                  </>
                )}

                <Pressable onPress={onClose} disabled={busy} style={styles.ghost}><Text style={styles.ghostText}>Cancel</Text></Pressable>
              </>
            ) : (
              <>
                <View style={styles.sheetHeader}>
                  <Pressable onPress={() => setReview(false)} disabled={busy}><Text style={styles.ghostText}>‹ Back</Text></Pressable>
                  <Text style={styles.sheetTitle}>Review withdrawal</Text>
                  <View style={{ width: 40 }} />
                </View>

                <ReviewRow label="Network" value={chain === 'near' ? `NEAR → ${CHAIN_LABEL[destination]}` : chain ? CHAIN_LABEL[chain] : '—'} />
                <ReviewRow label="Asset" value={cashCoin(chain)} />
                <ReviewRow label="Amount" value={`${amount} ${cashCoin(chain)}`} />
                <View style={styles.reviewAddressBlock}>
                  <Text style={styles.reviewLabel}>To</Text>
                  <Text style={styles.reviewAddress} selectable>{to.trim()}</Text>
                </View>

                <Text style={styles.warn}>Sends are final. Double-check the network and address above. A wrong network or address can permanently lose funds.</Text>

                {confirming && !busy ? (
                  <View style={styles.confirmCard}>
                    <Text style={styles.confirmTitle}>Send {amount} {cashCoin(chain)}?</Text>
                    <Text style={styles.confirmBody}>
                      {chain === 'near'
                        ? `From NEAR to ${CHAIN_LABEL[destination]} at ${shortAddress(to.trim())}.`
                        : `On ${chain ? CHAIN_LABEL[chain] : ''} to ${shortAddress(to.trim())}.`}
                      {' '}This can't be reversed.
                    </Text>
                    <View style={styles.confirmButtons}>
                      <Pressable onPress={() => setConfirming(false)} style={[styles.confirmButton, styles.confirmCancel]}><Text style={styles.confirmCancelText}>Cancel</Text></Pressable>
                      <Pressable onPress={() => { setConfirming(false); void executeSend(); }} style={[styles.confirmButton, styles.confirmGo]}><Text style={styles.primaryText}>Send now</Text></Pressable>
                    </View>
                  </View>
                ) : (
                  <Pressable disabled={busy} onPress={confirmSend} style={[styles.primary, busy && styles.disabled]}>
                    {busy ? <ActivityIndicator color={kivoTheme.colors.backgroundDeep} /> : <Text style={styles.primaryText}>Confirm withdrawal</Text>}
                  </Pressable>
                )}
                <Pressable onPress={() => { setConfirming(false); setReview(false); }} disabled={busy} style={styles.ghost}><Text style={styles.ghostText}>Edit</Text></Pressable>
              </>
            )}
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </KivoModal>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.reviewRow}>
      <Text style={styles.reviewLabel}>{label}</Text>
      <Text style={styles.reviewValue}>{value}</Text>
    </View>
  );
}

const c = kivoTheme.colors;
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: c.background },
  content: { padding: 20, paddingBottom: 40 },
  flex: { flex: 1 },
  header: { minHeight: 42, flexDirection: 'row', alignItems: 'center', gap: 8 },
  back: { color: c.cream, fontSize: 38, width: 30 },
  eyebrow: { color: c.accent, fontSize: 10, fontWeight: '800', letterSpacing: 2 },
  balance: { color: c.cream, fontSize: 40, fontWeight: '900', marginTop: 14 },
  sub: { color: c.textMuted, fontSize: 12 },
  actions: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 20 },
  action: { alignItems: 'center', gap: 6, flex: 1 },
  actionIcon: { width: 54, height: 54, borderRadius: 18, backgroundColor: c.surfaceRaised, alignItems: 'center', justifyContent: 'center' },
  actionGlyph: { color: c.cream, fontSize: 22, fontWeight: '900' },
  actionLabel: { color: c.text, fontSize: 12, fontWeight: '700' },
  gasBanner: { marginTop: 18, padding: 14, borderRadius: 16, backgroundColor: c.surfaceRaised, borderWidth: 1, borderColor: c.border },
  gasBannerOff: { backgroundColor: c.surface, borderColor: c.border },
  gasTitle: { color: c.text, fontWeight: '800', fontSize: 14 },
  card: { backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: 18, padding: 18, marginTop: 14 },
  cardTitle: { color: c.text, fontWeight: '800', fontSize: 15 },
  address: { color: c.cream, fontSize: 14, fontWeight: '800', marginTop: 10 },
  note: { color: c.textMuted, fontSize: 12, lineHeight: 18, marginTop: 7 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: c.border },
  rowLeft: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 },
  rowName: { color: c.text, fontWeight: '700', fontSize: 13 },
  rowValue: { color: c.text, fontWeight: '800', fontSize: 13 },
  networkBadge: { width: 32, height: 32, borderRadius: 16, backgroundColor: c.surfaceRaised, borderWidth: 1, borderColor: c.border, alignItems: 'center', justifyContent: 'center' },
  networkGlyph: { color: c.cream, fontSize: 13, fontWeight: '900' },
  backdrop: { flex: 1, backgroundColor: 'rgba(3,37,33,0.78)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: c.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, paddingBottom: 36, maxHeight: '92%', borderWidth: 1, borderBottomWidth: 0, borderColor: c.border },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 },
  sheetTitle: { color: c.text, fontSize: 18, fontWeight: '800' },
  networkList: { maxHeight: 520, flexShrink: 1, marginBottom: 0 },
  selectedNetworkCard: { backgroundColor: c.surfaceRaised, borderWidth: 1, borderColor: c.border, borderRadius: 16, padding: 14, marginBottom: 4 },
  selectedNetworkTitle: { color: c.text, fontSize: 16, fontWeight: '800' },
  selectedNetworkBalance: { color: c.textMuted, fontSize: 12, marginTop: 3 },
  changeText: { color: c.accent, fontSize: 12, fontWeight: '800' },
  depositNetworkContent: { paddingBottom: 4 },
  backText: { color: c.text, fontSize: 14, fontWeight: '700' },
  headerSpacer: { width: 20 },
  addressSectionTitle: { color: c.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 0.5, marginTop: 0, textTransform: 'uppercase' },
  networkRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: c.surfaceRaised, borderWidth: 1, borderColor: c.border, borderRadius: 16, paddingHorizontal: 16, paddingVertical: 15, marginBottom: 8 },
  networkRowActive: { backgroundColor: c.surfaceRaised, borderWidth: 1, borderColor: c.accent },
  disabledRow: { opacity: 0.45 },
  networkRowText: { color: c.text, fontSize: 15, fontWeight: '700' },
  networkRowBalance: { color: c.textMuted, fontSize: 13, fontWeight: '600' },
  chevron: { color: c.textMuted, fontSize: 20, lineHeight: 20 },
  sectionLabel: { color: c.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 0.5, marginTop: 8, marginBottom: 7, textTransform: 'uppercase' },
  addressPanel: { backgroundColor: c.surfaceRaised, borderRadius: 12, borderWidth: 1, borderColor: c.border, padding: 14, marginTop: 8 },
  qrWrap: { backgroundColor: '#FFFFFF', padding: 12, borderRadius: 18, alignSelf: 'center', marginTop: 8, marginBottom: 8 },
  addressPanelHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  addressLabel: { color: c.textMuted, fontSize: 11, fontWeight: '700' },
  addressActions: { flexDirection: 'row', gap: 8, marginTop: 8 },
  shareButton: { flex: 1, height: 44, borderRadius: 14, backgroundColor: c.surfaceRaised, borderWidth: 1, borderColor: c.border, alignItems: 'center', justifyContent: 'center' },
  shareButtonText: { color: c.text, fontWeight: '800', fontSize: 13 },
  copyButton: { flex: 1, height: 44, borderRadius: 14, backgroundColor: c.cream, alignItems: 'center', justifyContent: 'center', marginRight: 8 },
  copyButtonText: { color: c.backgroundDeep, fontWeight: '800', fontSize: 13 },
  addressFull: { color: c.text, fontSize: 14, fontWeight: '600', marginTop: 8, backgroundColor: c.surfaceRaised, borderWidth: 1, borderColor: c.border, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12 },
  label: { color: c.textMuted, fontSize: 11, fontWeight: '900', letterSpacing: 1, marginTop: 12, textTransform: 'uppercase' },
  input: { height: 48, borderRadius: 14, paddingHorizontal: 14, backgroundColor: c.backgroundDeep, color: c.text, fontSize: 15, borderWidth: 1, borderColor: c.border, marginTop: 7 },
  amountRow: { flexDirection: 'row', gap: 8 },
  flexInput: { flex: 1 },
  max: { height: 48, paddingHorizontal: 16, borderRadius: 14, backgroundColor: c.accent, justifyContent: 'center', alignSelf: 'flex-end', marginTop: 7 },
  maxText: { color: c.backgroundDeep, fontWeight: '900' },
  available: { color: c.textMuted, fontSize: 11, marginTop: 7 },
  warn: { color: c.danger, fontSize: 12, lineHeight: 18, marginTop: 8 },
  ok: { color: c.success, fontSize: 12.5, lineHeight: 18, marginTop: 8, fontWeight: '700' },
  reviewRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: c.border },
  reviewLabel: { color: c.textMuted, fontSize: 13, fontWeight: '600' },
  reviewValue: { color: c.text, fontSize: 14, fontWeight: '800', maxWidth: '65%', textAlign: 'right' },
  reviewAddressBlock: { marginTop: 14 },
  reviewAddress: { color: c.text, fontSize: 13, fontWeight: '600', marginTop: 7, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: 12, padding: 12 },
  primary: { marginTop: 14, height: 52, borderRadius: 26, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center' },
  primaryText: { color: c.backgroundDeep, fontWeight: '900', fontSize: 15 },
  confirmCard: { marginTop: 14, padding: 16, borderRadius: 20, backgroundColor: c.surfaceRaised, borderWidth: 1, borderColor: c.border },
  confirmTitle: { color: c.cream, fontSize: 17, fontWeight: '900' },
  confirmBody: { color: c.textMuted, fontSize: 13, lineHeight: 19, marginTop: 6 },
  confirmButtons: { flexDirection: 'row', gap: 10, marginTop: 14 },
  confirmButton: { flex: 1, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  confirmCancel: { borderWidth: 1, borderColor: c.border },
  confirmCancelText: { color: c.cream, fontWeight: '800', fontSize: 15 },
  confirmGo: { backgroundColor: c.accent },
  outcome: { alignItems: 'center', paddingTop: 8, paddingBottom: 4 },
  outcomeIcon: { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  outcomeIconOk: { backgroundColor: c.accent },
  outcomeIconFail: { backgroundColor: c.danger },
  outcomeIconText: { color: c.backgroundDeep, fontSize: 34, fontWeight: '900' },
  outcomeTitle: { color: c.cream, fontSize: 20, fontWeight: '900', textAlign: 'center' },
  outcomeBody: { color: c.textMuted, fontSize: 14, lineHeight: 20, textAlign: 'center', marginTop: 8, paddingHorizontal: 8 },
  outcomeLink: { color: c.accent, fontWeight: '800', fontSize: 13.5, marginTop: 12 },
  outcomeButton: { alignSelf: 'stretch', marginTop: 20 },
  ghost: { height: 44, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  ghostText: { color: c.cream, fontWeight: '800' },
  disabled: { opacity: 0.45 },
});
