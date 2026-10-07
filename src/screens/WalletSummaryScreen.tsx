import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Linking, Modal, Platform, Pressable, ScrollView, Share, StyleSheet, Text, TextInput, View } from 'react-native';
import { kivoTheme } from '../theme/kivoTheme';
import { getWalletSession, loadWalletSession, subscribeToWallet, withDeviceAccount, type WalletSession } from '../state/walletStore';
import { useSettings } from '../state/settingsStore';
import { addNotification } from '../state/notificationStore';
import { CHAIN_LABEL, MAINNET_CHAIN_IDS, type ChainKey } from '@kivo/trading/core/chainData';
import { fetchCashBalances, totalCashUsd, type CashBalanceRow } from '@kivo/trading/kivo/balances';
import { isValidEvmRecipient, withdrawUsdcGasless } from '@kivo/trading/kivo/cash';
import { explorerTxUrl } from '@kivo/trading/kivo/execute';
import { fetchGaslessStatus, type GaslessStatus } from '@kivo/trading/kivo/gasless';
import { formatAmount, formatUsd, shortAddress, USDC_CHAINS } from '@kivo/trading/kivo/tokens';

type Sheet = null | 'deposit' | 'withdraw';

/**
 * Kivo mobile cash, the Mango Pro way: the wallet lives on this phone, cash
 * is USDC, and moving it out is gasless (Relay submits, Kivo pays gas), so
 * nobody ever needs ETH/BNB just to withdraw.
 */
export function WalletSummaryScreen({ onBack, onTrade, initialAction }: { onBack?: () => void; onTrade?: () => void; initialAction?: 'deposit' | 'withdraw' }) {
  const [wallet, setWallet] = useState<WalletSession | null>(getWalletSession());
  const [rows, setRows] = useState<CashBalanceRow[] | null>(null);
  const [sheet, setSheet] = useState<Sheet>(initialAction ?? null);
  const [gasless, setGasless] = useState<GaslessStatus | null>(null);
  const settings = useSettings();

  useEffect(() => {
    const unsub = subscribeToWallet(setWallet);
    loadWalletSession().catch(() => {});
    fetchGaslessStatus().then(setGasless);
    return unsub;
  }, []);
  const load = () => {
    if (!wallet) return;
    setRows(null);
    fetchCashBalances(wallet.address).then(setRows);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [wallet?.address]);

  const total = rows ? totalCashUsd(rows) : null;
  const funded = rows?.filter(r => r.status === 'error' || r.balance.amount > 0) ?? [];
  const mask = (value: string) => (settings.hideBalances ? '••••' : value);

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <View style={styles.header}>{onBack && <Pressable onPress={onBack} hitSlop={10}><Text style={styles.back}>‹</Text></Pressable>}<Text style={styles.eyebrow}>KIVO WALLET</Text></View>
      {!wallet ? <View style={styles.card}><Text style={styles.cardTitle}>No wallet on this phone</Text><Text style={styles.note}>Create or import a Kivo wallet to hold USDC and trade.</Text></View> : <>
        <Text style={styles.balance}>{total == null ? '…' : mask(formatUsd(total.total))}</Text>
        <Text style={styles.sub}>{total == null ? 'Reading USDC on supported networks…' : total.complete ? 'Total cash · USDC across supported networks' : 'Some networks did not respond — total may be incomplete'}</Text>
        <View style={styles.actions}>
          <Action glyph="↓" label="Deposit" onPress={() => setSheet('deposit')} />
          <Action glyph="↑" label="Withdraw" onPress={() => setSheet('withdraw')} />
          {onTrade && <Action glyph="⇄" label="Trade" onPress={onTrade} />}
          <Action glyph="⟳" label="Refresh" onPress={load} />
        </View>
        <View style={[styles.gasBanner, gasless && !gasless.available && styles.gasBannerOff]}>
          <Text style={styles.gasTitle}>{gasless == null ? 'Checking gasless trading…' : gasless.available ? '⛽  Gasless is on' : '⛽  Gasless is off'}</Text>
          <Text style={styles.note}>{gasless?.available === false ? gasless.reason : 'Trades and withdrawals need only USDC. Kivo pays the network gas.'}</Text>
        </View>
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Cash by network</Text>
          {rows == null ? <ActivityIndicator color={kivoTheme.colors.accent} style={{ marginTop: 12 }} />
            : funded.length === 0 ? <Text style={styles.note}>No USDC yet. Tap Deposit and send USDC on any supported network.</Text>
            : funded.map(row => (
              <View key={row.chainKey} style={styles.row}>
                <Text style={styles.rowName}>USDC · {CHAIN_LABEL[row.chainKey]}</Text>
                <Text style={styles.rowValue}>{row.status === 'ok' ? mask(formatAmount(row.balance.amount, 2)) : 'Unavailable'}</Text>
              </View>
            ))}
        </View>
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Device wallet</Text>
          <Text style={styles.address} selectable>{shortAddress(wallet.address, 10, 8)}</Text>
          <Text style={styles.note}>Your keys stay in this phone’s secure storage. Kivo never displays or uploads your recovery phrase.</Text>
        </View>
      </>}

      {wallet && <DepositSheet visible={sheet === 'deposit'} address={wallet.address} onClose={() => setSheet(null)} />}
      {wallet && <WithdrawSheet visible={sheet === 'withdraw'} rows={rows} gasless={gasless} onClose={() => setSheet(null)} onDone={() => { setSheet(null); load(); }} />}
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

function DepositSheet({ visible, address, onClose }: { visible: boolean; address: string; onClose: () => void }) {
  const share = async () => { try { await Share.share({ message: address }); } catch { /* dismissed */ } };
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <Text style={styles.sheetTitle}>Deposit USDC</Text>
          <Text style={styles.note}>Send USDC to this address on any of these networks. It is the same address on all of them.</Text>
          <View style={styles.addressBox}><Text style={styles.addressFull} selectable>{address}</Text></View>
          <View style={styles.chips}>{USDC_CHAINS.map(chain => <Text key={chain} style={styles.chip}>{CHAIN_LABEL[chain]}</Text>)}</View>
          <Text style={styles.warn}>Only send USDC on the networks above. Other assets or networks may not show up in your cash.</Text>
          <Pressable onPress={share} style={styles.primary}><Text style={styles.primaryText}>Share address</Text></Pressable>
          <Pressable onPress={onClose} style={styles.ghost}><Text style={styles.ghostText}>Done</Text></Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function WithdrawSheet({ visible, rows, gasless, onClose, onDone }: { visible: boolean; rows: CashBalanceRow[] | null; gasless: GaslessStatus | null; onClose: () => void; onDone: () => void }) {
  const usable = (rows ?? []).filter((r): r is CashBalanceRow & { status: 'ok' } => r.status === 'ok' && r.balance.amount > 0);
  const [chain, setChain] = useState<ChainKey | null>(null);
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string; hash?: string; chainId?: number } | null>(null);

  useEffect(() => { if (visible) { setResult(null); setChain(current => current ?? usable[0]?.chainKey ?? null); } }, [visible, usable.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const row = usable.find(r => r.chainKey === chain);
  const available = row?.balance.amount ?? 0;
  const parsed = Number(amount);
  const problem = !to ? null : !isValidEvmRecipient(to) ? 'Enter a valid 0x… address.'
    : !amount ? null : !(parsed > 0) ? 'Enter an amount greater than zero.'
    : parsed > available + 1e-9 ? `More than your ${formatAmount(available, 2)} USDC on ${chain ? CHAIN_LABEL[chain] : ''}.` : null;
  const canSend = Boolean(gasless?.available && chain && to && amount && !problem && !busy);

  const send = async () => {
    if (!chain || !canSend) return;
    setBusy(true); setResult(null);
    try {
      const outcome = await withDeviceAccount(`Send ${amount} USDC`, account => withdrawUsdcGasless({ account, chainKey: chain, to, amount }));
      setResult({ ok: true, message: `Sent ${amount} USDC on ${CHAIN_LABEL[chain]}.`, hash: outcome.hash, chainId: MAINNET_CHAIN_IDS[chain] });
      addNotification('Withdrawal sent', `${amount} USDC to ${shortAddress(to)}`);
      setAmount(''); setTo('');
    } catch (error) {
      setResult({ ok: false, message: error instanceof Error ? error.message : 'Withdrawal failed. Nothing was sent.' });
    } finally {
      setBusy(false);
    }
  };
  const explorer = result?.hash && result.chainId ? explorerTxUrl(result.chainId, result.hash) : null;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={() => { if (!busy) onClose(); }}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable style={styles.backdrop} onPress={() => { if (!busy) onClose(); }}>
          <Pressable style={styles.sheet} onPress={() => {}}>
            <Text style={styles.sheetTitle}>Withdraw USDC</Text>
            {gasless?.available === false && <Text style={styles.warn}>{gasless.reason}</Text>}
            {rows == null ? <ActivityIndicator color={kivoTheme.colors.accent} />
              : usable.length === 0 ? <Text style={styles.note}>You have no USDC to withdraw yet.</Text>
              : <>
                <Text style={styles.label}>From network</Text>
                <View style={styles.chips}>
                  {usable.map(r => (
                    <Pressable key={r.chainKey} onPress={() => setChain(r.chainKey)} style={[styles.chipButton, chain === r.chainKey && styles.chipActive]}>
                      <Text style={[styles.chipButtonText, chain === r.chainKey && styles.chipActiveText]}>{CHAIN_LABEL[r.chainKey]} · {formatAmount(r.balance.amount, 2)}</Text>
                    </Pressable>
                  ))}
                </View>
                <Text style={styles.label}>To address</Text>
                <TextInput value={to} onChangeText={setTo} placeholder="0x…" placeholderTextColor={kivoTheme.colors.textMuted} autoCapitalize="none" autoCorrect={false} style={styles.input} />
                <Text style={styles.label}>Amount (USDC)</Text>
                <View style={styles.amountRow}>
                  <TextInput value={amount} onChangeText={v => setAmount(v.replace(',', '.'))} keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor={kivoTheme.colors.textMuted} style={[styles.input, styles.flex]} />
                  <Pressable onPress={() => setAmount(String(Math.floor(available * 1e6) / 1e6))} style={styles.max}><Text style={styles.maxText}>MAX</Text></Pressable>
                </View>
                {problem && <Text style={styles.warn}>{problem}</Text>}
                <Text style={styles.note}>Network gas: paid by Kivo. Double-check the address — transfers can’t be reversed.</Text>
                {result && <Text style={result.ok ? styles.ok : styles.warn}>{result.message}</Text>}
                {explorer && <Pressable onPress={() => Linking.openURL(explorer)}><Text style={styles.link}>View transaction</Text></Pressable>}
                <Pressable disabled={!canSend} onPress={send} style={[styles.primary, !canSend && styles.disabled]}>
                  <Text style={styles.primaryText}>{busy ? 'Sending…' : 'Send USDC'}</Text>
                </Pressable>
              </>}
            {!busy && <Pressable onPress={result?.ok ? onDone : onClose} style={styles.ghost}><Text style={styles.ghostText}>{result?.ok ? 'Done' : 'Cancel'}</Text></Pressable>}
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
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
  gasBanner: { marginTop: 18, padding: 14, borderRadius: 16, backgroundColor: 'rgba(47,214,123,0.10)', borderWidth: 1, borderColor: 'rgba(47,214,123,0.35)' },
  gasBannerOff: { backgroundColor: c.surface, borderColor: c.border },
  gasTitle: { color: c.text, fontWeight: '800', fontSize: 14 },
  card: { backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: 18, padding: 18, marginTop: 14 },
  cardTitle: { color: c.text, fontWeight: '800', fontSize: 15 },
  address: { color: c.cream, fontSize: 14, fontWeight: '800', marginTop: 10 },
  note: { color: c.textMuted, fontSize: 12, lineHeight: 18, marginTop: 7 },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: c.border },
  rowName: { color: c.text, fontWeight: '700', fontSize: 13 },
  rowValue: { color: c.text, fontWeight: '800', fontSize: 13 },
  backdrop: { flex: 1, backgroundColor: 'rgba(1,15,13,0.7)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: c.background, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, paddingBottom: 34, borderWidth: 1, borderColor: c.border, gap: 6 },
  sheetTitle: { color: c.text, fontSize: 20, fontWeight: '800' },
  addressBox: { marginTop: 10, padding: 14, borderRadius: 14, backgroundColor: c.backgroundDeep },
  addressFull: { color: c.cream, fontWeight: '800', fontSize: 13.5, lineHeight: 20 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  chip: { color: c.text, fontSize: 11.5, fontWeight: '700', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999, backgroundColor: c.surface, overflow: 'hidden' },
  chipButton: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border },
  chipButtonText: { color: c.text, fontWeight: '700', fontSize: 12 },
  chipActive: { backgroundColor: c.cream, borderColor: c.cream },
  chipActiveText: { color: c.backgroundDeep },
  label: { color: c.textMuted, fontSize: 11, fontWeight: '900', letterSpacing: 1, marginTop: 12, textTransform: 'uppercase' },
  input: { height: 48, borderRadius: 14, paddingHorizontal: 14, backgroundColor: c.surface, color: c.text, fontSize: 15, borderWidth: 1, borderColor: c.border },
  amountRow: { flexDirection: 'row', gap: 8 },
  max: { height: 48, paddingHorizontal: 16, borderRadius: 14, backgroundColor: c.surfaceRaised, justifyContent: 'center' },
  maxText: { color: c.cream, fontWeight: '900' },
  warn: { color: c.danger, fontSize: 12, lineHeight: 18, marginTop: 6 },
  ok: { color: c.success, fontSize: 12.5, lineHeight: 18, marginTop: 8, fontWeight: '700' },
  link: { color: c.accent, fontWeight: '800', marginTop: 6 },
  primary: { marginTop: 14, height: 52, borderRadius: 26, backgroundColor: '#2FD67B', alignItems: 'center', justifyContent: 'center' },
  primaryText: { color: c.backgroundDeep, fontWeight: '900', fontSize: 15 },
  ghost: { height: 44, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  ghostText: { color: c.cream, fontWeight: '800' },
  disabled: { opacity: 0.45 },
});
