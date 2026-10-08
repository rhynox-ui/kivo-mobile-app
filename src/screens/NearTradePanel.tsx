import React, {useEffect, useMemo, useState} from 'react';
import {ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, View} from 'react-native';
import bs58 from 'bs58';
import {kivoTheme} from '../theme/kivoTheme';
import {NEAR_USDC, NEAR_USDC_DECIMALS, type TradeChain} from '@kivo/trading/core/chainData';
import {fetchNearTokenBalance, fetchNearTokenMeta, executeNearTrade, quoteNearTrade, type NearTradeQuote} from '@kivo/trading/core/nearTrade';
import type {DerivedAccounts} from '@kivo/trading/wallet/keys';
import type {KivoToken, TradeSide} from '@kivo/trading/kivo/tokens';
import {withDeviceAccounts, type WalletSession} from '../state/walletStore';
import {oneClickSwapStore} from '@kivo/trading/wallet/oneClickSwapStore';
import {fundNearUsdcForTrade} from '@kivo/trading/core/nearTrade';

function sessionFromAccounts(accounts: {evm: any; solana: any; near: {address: string; privateKey: string}}): DerivedAccounts {
  const evmKey = accounts.evm.getHdKey().privateKey;
  if (!evmKey) throw new Error('The device wallet key is unavailable.');
  return {
    evm: {address: accounts.evm.address, privateKey: `0x${Buffer.from(evmKey).toString('hex')}`},
    solana: {address: accounts.solana.publicKey.toBase58(), privateKey: bs58.encode(accounts.solana.secretKey)},
    near: accounts.near,
    authMethod: 'seed',
  };
}

export function NearTradePanel({token, wallet, initialSide, onOpenHistory}: {
  token: KivoToken & {chainKey: 'near'};
  wallet: WalletSession;
  initialSide: TradeSide;
  onOpenHistory?: () => void;
}) {
  const [side, setSide] = useState<TradeSide>(initialSide);
  const [amount, setAmount] = useState('');
  const [decimals, setDecimals] = useState(18);
  const [usdcBalance, setUsdcBalance] = useState<bigint>(0n);
  const [tokenBalance, setTokenBalance] = useState<bigint>(0n);
  const [quote, setQuote] = useState<NearTradeQuote|null>(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [funding, setFunding] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    let cancelled = false;
    setQuote(null); setError(''); setMessage('');
    Promise.all([
      fetchNearTokenMeta(token.tokenAddress),
      fetchNearTokenBalance(NEAR_USDC, wallet.nearAddress ?? '').catch(() => 0n),
      fetchNearTokenBalance(token.tokenAddress, wallet.nearAddress ?? '').catch(() => 0n),
    ]).then(([meta, usdc, balance]) => {
      if (cancelled) return;
      setDecimals(meta.decimals);
      setUsdcBalance(usdc);
      setTokenBalance(balance);
    }).catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load NEAR token data.'); });
    return () => {cancelled = true;};
  }, [token.tokenAddress, wallet.nearAddress]);

  const numeric = Number(amount);
  const valid = Number.isFinite(numeric) && numeric > 0;
  const available = side === 'buy' ? Number(usdcBalance) / 10 ** NEAR_USDC_DECIMALS : Number(tokenBalance) / 10 ** decimals;

  useEffect(() => {
    if (!valid || numeric > available || !wallet.nearAddress) {setQuote(null); return;}
    let cancelled = false;
    const timer = setTimeout(() => {
      setLoading(true); setError('');
      const payUnits = BigInt(Math.floor(numeric * 10 ** (side === 'buy' ? NEAR_USDC_DECIMALS : decimals)));
      quoteNearTrade({side, token: token.tokenAddress, payUnits, accountId: wallet.nearAddress!, slippageBps: 100})
        .then(q => {if (!cancelled) setQuote(q);})
        .catch(e => {if (!cancelled) {setQuote(null); setError(e instanceof Error ? e.message : 'No NEAR route is available.');}})
        .finally(() => {if (!cancelled) setLoading(false);});
    }, 500);
    return () => {cancelled = true; clearTimeout(timer);};
  }, [amount, side, available, decimals, token.tokenAddress, wallet.nearAddress, valid, numeric]);

  const execute = async () => {
    if (!quote || running) return;
    setRunning(true); setError(''); setMessage('');
    try {
      await withDeviceAccounts(`Confirm NEAR ${side} ${token.symbol}`, async accounts => {
        const session = sessionFromAccounts(accounts);
        const neededNearUsdc = quote.side === 'buy'
          ? quote.payUnits
          : 0n;
        const currentNearUsdc = await fetchNearTokenBalance(NEAR_USDC, session.near!.address);
        if (neededNearUsdc > currentNearUsdc) {
          setFunding(true);
          await fundNearUsdcForTrade(session, neededNearUsdc - currentNearUsdc, {store: oneClickSwapStore});
          setFunding(false);
        }
        const result = await executeNearTrade(session, quote, {requote: () => quoteNearTrade({
          side: quote.side, token: quote.token, payUnits: quote.payUnits, accountId: session.near!.address, slippageBps: quote.slippageBps,
        })});
        setMessage(result.status === 'refunded' ? 'Trade was refunded by the exchange.' : result.status === 'partial' ? 'Trade partially filled.' : `NEAR trade complete · ${result.hashes.length} transaction(s)`);
        setQuote(null);
        setAmount('');
        onOpenHistory?.();
      });
    } catch (e) {
      setFunding(false);
      setError(e instanceof Error ? e.message : 'NEAR trade failed. Nothing was signed.');
    } finally {setRunning(false);}
  };

  const insufficient = valid && side === 'sell' && numeric > available;
  return (
    <View style={styles.container}>
      <View style={styles.header}><Text style={styles.title}>{token.symbol} · NEAR</Text><Text style={styles.account}>{wallet.nearAddress ? `${wallet.nearAddress.slice(0,8)}…${wallet.nearAddress.slice(-6)}` : 'NEAR account unavailable'}</Text></View>
      <View style={styles.switch}><Pressable onPress={() => {setSide('buy');setAmount('');}} style={[styles.tab, side==='buy'&&styles.active]}><Text style={styles.tabText}>Buy</Text></Pressable><Pressable onPress={() => {setSide('sell');setAmount('');}} style={[styles.tab, side==='sell'&&styles.active]}><Text style={styles.tabText}>Sell</Text></Pressable></View>
      <Text style={styles.label}>{side === 'buy' ? 'USDC on NEAR' : token.symbol}</Text>
      <TextInput value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor={c.textMuted} style={styles.input}/>
      <Text style={styles.balance}>Available {available.toFixed(Math.min(side==='buy'?6:6, decimals))}</Text>
      {loading && <ActivityIndicator color={c.accent} style={{marginTop:12}}/>}
      {quote && <View style={styles.quote}><Text style={styles.quoteTitle}>Quote ready</Text><Text style={styles.muted}>Minimum received: {quote.minReceiveUnits.toString()} base units</Text><Text style={styles.muted}>Kivo fee: {(Number(quote.fee)/1e6).toFixed(4)} USDC</Text></View>}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {message ? <Text style={styles.success}>{message}</Text> : null}
      <Pressable disabled={!quote || running || insufficient} onPress={() => {
        Alert.alert('Confirm NEAR trade', `${side === 'buy' ? 'Buy' : 'Sell'} ${amount} ${side === 'buy' ? token.symbol : token.symbol} on NEAR?`, [
          {text:'Cancel',style:'cancel'},
          {text:'Confirm',onPress:()=>{void execute();}},
        ]);
      }} style={[styles.button, (!quote || running || insufficient) && styles.disabled]}>
        {running ? <ActivityIndicator color={c.backgroundDeep}/> : <Text style={styles.buttonText}>{funding ? 'Funding from Kivo cash…' : side === 'buy' ? 'Buy' : 'Sell'} {token.symbol}</Text>}
      </Pressable>
    </View>
  );
}
const c=kivoTheme.colors;
const styles=StyleSheet.create({
  container:{flex:1,backgroundColor:c.background,padding:20},
  header:{marginBottom:16}, title:{color:c.text,fontSize:22,fontWeight:'900'},account:{color:c.textMuted,fontSize:11,marginTop:4},
  switch:{flexDirection:'row',gap:8},tab:{flex:1,padding:13,borderRadius:14,backgroundColor:c.surface,alignItems:'center'},active:{backgroundColor:c.cream},tabText:{color:c.text,fontWeight:'900'},
  label:{color:c.textMuted,fontSize:12,fontWeight:'800',marginTop:20},input:{marginTop:8,height:58,borderRadius:16,borderWidth:1,borderColor:c.border,color:c.text,fontSize:24,paddingHorizontal:16,backgroundColor:c.surface},
  balance:{color:c.textMuted,fontSize:11,marginTop:7},quote:{marginTop:16,padding:14,borderRadius:16,backgroundColor:c.surface,borderWidth:1,borderColor:c.border},quoteTitle:{color:c.text,fontWeight:'900',marginBottom:6},muted:{color:c.textMuted,fontSize:12,lineHeight:18},
  error:{color:c.danger,fontSize:12,lineHeight:18,marginTop:12},success:{color:c.success,fontSize:12,lineHeight:18,marginTop:12},button:{marginTop:20,height:56,borderRadius:28,backgroundColor:c.cream,alignItems:'center',justifyContent:'center'},buttonText:{color:c.backgroundDeep,fontWeight:'900',fontSize:16},disabled:{opacity:.4},
});
