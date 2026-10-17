import React, {useEffect, useMemo, useState} from 'react';
import {ActivityIndicator, Image, Linking, Modal, Pressable, StyleSheet, Text, TextInput, View} from 'react-native';
import {parseUnits} from 'viem';
import bs58 from 'bs58';
import {kivoTheme} from '../theme/kivoTheme';
import {NEAR_USDC, NEAR_USDC_DECIMALS} from '@kivo/trading/core/chainData';
import {fetchNearTokenBalance, fetchNearTokenMeta, executeNearTrade, quoteNearTrade, type NearTradeQuote} from '@kivo/trading/core/nearTrade';
import type {DerivedAccounts} from '@kivo/trading/wallet/keys';
import type {KivoToken, TradeSide} from '@kivo/trading/kivo/tokens';
import {withDeviceAccounts, type WalletSession} from '../state/walletStore';
import {oneClickSwapStore} from '@kivo/trading/wallet/oneClickSwapStore';
import {fundNearUsdcForTrade, NearSendError} from '@kivo/trading/core/nearTrade';
import {recordTrade} from '@kivo/trading/kivo/history';
import {MIN_TRADE_USD} from '@kivo/trading/core/fees';
import {TokenChartPanel} from '../components/TokenChartPanel';
import { KivoModal } from '../components/KivoModal';

function sessionFromAccounts(accounts: {evm: {address: string}; evmPrivateKey: string; solana: {publicKey: {toBase58(): string}; secretKey: Uint8Array} | null; near: {address: string; privateKey: string} | null}): DerivedAccounts {
  return {
    evm: {address: accounts.evm.address, privateKey: accounts.evmPrivateKey},
    solana: {address: accounts.solana ? accounts.solana.publicKey.toBase58() : '', privateKey: accounts.solana ? bs58.encode(accounts.solana.secretKey) : ''},
    near: accounts.near ?? undefined,
    authMethod: 'seed',
  };
}

type Result = {kind:'success'|'partial'|'refunded'|'failed'|'unknown'; message:string; hashes:string[]};

export function NearTradePanel({token, wallet, initialSide, onOpenHistory}: {
  token: KivoToken & {chainKey:'near'};
  wallet: WalletSession;
  initialSide: TradeSide;
  onOpenHistory?: () => void;
}) {
  const [side,setSide]=useState<TradeSide>(initialSide);
  const [amount,setAmount]=useState('');
  const [decimals,setDecimals]=useState(18);
  const [usdcBalance,setUsdcBalance]=useState(0n);
  const [tokenBalance,setTokenBalance]=useState(0n);
  const [quote,setQuote]=useState<NearTradeQuote|null>(null);
  const [loading,setLoading]=useState(false);
  const [running,setRunning]=useState(false);
  const [funding,setFunding]=useState(false);
  const [error,setError]=useState('');
  const [result,setResult]=useState<Result|null>(null);

  const refreshBalances=async()=>{
    if(!wallet.nearAddress)return;
    const [meta,usdc,balance]=await Promise.all([
      fetchNearTokenMeta(token.tokenAddress),
      fetchNearTokenBalance(NEAR_USDC,wallet.nearAddress).catch(()=>0n),
      fetchNearTokenBalance(token.tokenAddress,wallet.nearAddress).catch(()=>0n),
    ]);
    setDecimals(meta.decimals); setUsdcBalance(usdc); setTokenBalance(balance);
  };

  useEffect(()=>{let cancelled=false; setQuote(null);setError('');setResult(null); refreshBalances().catch(e=>{if(!cancelled)setError(e instanceof Error?e.message:'Could not load NEAR token data.');}); return()=>{cancelled=true;};},[token.tokenAddress,wallet.nearAddress]);

  const numeric=Number(amount);
  const valid=Number.isFinite(numeric)&&numeric>0;
  const inputUnits=useMemo(()=>{try{return valid?parseUnits(amount,side==='buy'?NEAR_USDC_DECIMALS:decimals):0n;}catch{return 0n;}},[amount,side,decimals,valid]);
  const availableUnits=side==='buy'?usdcBalance:tokenBalance;
  const available=Number(availableUnits)/(10**(side==='buy'?NEAR_USDC_DECIMALS:decimals));
  const insufficient=valid&&inputUnits>availableUnits;
  // $2 minimum: a buy is entered in USDC; a sell is checked on its quoted USDC output.
  const buyBelowMin=side==='buy'&&valid&&numeric<MIN_TRADE_USD;

  useEffect(()=>{
    if(!valid||inputUnits<=0n||insufficient||buyBelowMin||!wallet.nearAddress){setQuote(null);return;}
    let cancelled=false;
    const timer=setTimeout(()=>{
      setLoading(true);setError('');
      quoteNearTrade({side,token:token.tokenAddress,payUnits:inputUnits,accountId:wallet.nearAddress!,slippageBps:100})
        .then(q=>{if(!cancelled)setQuote(q);})
        .catch(e=>{if(!cancelled){setQuote(null);setError(e instanceof Error?e.message:'No NEAR route is available.');}})
        .finally(()=>{if(!cancelled)setLoading(false);});
    },450);
    return()=>{cancelled=true;clearTimeout(timer);};
  },[amount,side,inputUnits,insufficient,buyBelowMin,token.tokenAddress,wallet.nearAddress,valid]);

  const receiveAmount=quote ? Number(quote.receiveUnits)/(10**(side==='buy'?decimals:NEAR_USDC_DECIMALS)) : null;
  const minimum=quote ? Number(quote.minReceiveUnits)/(10**(side==='buy'?decimals:NEAR_USDC_DECIMALS)) : null;
  const belowMin=buyBelowMin||(side==='sell'&&receiveAmount!=null&&receiveAmount<MIN_TRADE_USD);
  const fee=quote ? Number(quote.fee)/10**NEAR_USDC_DECIMALS : 0;

  const choosePreset=(pct:number)=>{
    if(available<=0)return;
    const raw=Math.floor(available*pct/100*10**(side==='buy'?6:decimals))/(10**(side==='buy'?6:decimals));
    setAmount(String(raw));
  };

  const execute=async()=>{
    if(!quote||running||!wallet.nearAddress||belowMin)return;
    setRunning(true);setError('');setResult(null);
    try{
      await withDeviceAccounts(`Confirm NEAR ${side} ${token.symbol}`,async accounts=>{
        const session=sessionFromAccounts(accounts);const near=session.near;if(!near)throw new Error('NEAR account is unavailable.');
        if(side==='buy'){
          const currentUsdc=await fetchNearTokenBalance(NEAR_USDC,near.address);
          if(quote.payUnits>currentUsdc){
            setFunding(true);
            await fundNearUsdcForTrade(session,quote.payUnits-currentUsdc,{store:oneClickSwapStore});
            setFunding(false);
          }
        }
        const fresh=await quoteNearTrade({side:quote.side,token:quote.token,payUnits:quote.payUnits,accountId:near.address,slippageBps:quote.slippageBps});
        const entry=await executeNearTrade(session,fresh,{requote:()=>quoteNearTrade({side:fresh.side,token:fresh.token,payUnits:fresh.payUnits,accountId:near.address,slippageBps:fresh.slippageBps})});
        const hashes=entry.hashes;
        const kind=entry.status;
        const message=kind==='ok'?'Trade complete.':kind==='partial'?'Only part of this trade filled; the rest was returned to you.':kind==='refunded'?'The exchange cancelled this trade and returned your funds.':kind==='failed'?'The NEAR trade failed. No trade was completed.':'The NEAR trade is still being confirmed.';
        setResult({kind:kind==='ok'?'success':kind,message,hashes});
        if(hashes.length){
          recordTrade({
            side,
            token:{chainKey:'near',address:token.tokenAddress,symbol:token.symbol,name:token.name,imageUrl:token.imageUrl??null},
            pay:{amount,symbol:side==='buy'?'USDC':token.symbol,chainKey:'near'},
            receive:{amount:kind==='ok'||kind==='partial'?String(receiveAmount??''):null,symbol:side==='buy'?token.symbol:'USDC',chainKey:'near'},
            txHashes:hashes,chainIds:[],requestId:null,status:kind==='ok'||kind==='partial'?'success':kind==='refunded'?'refunded':'failed',error:kind==='partial'?'Partially filled — the unfilled amount was returned.':kind==='refunded'?'The exchange cancelled this trade and returned the funds.':undefined
          });
        }
        await refreshBalances();
      });
    }catch(e){
      setFunding(false);
      const hashes=e instanceof NearSendError?e.sent.map(x=>x.hash).filter(Boolean):[];
      const message=e instanceof Error?e.message:'NEAR trade failed. Nothing was signed.';
      setResult({kind:'failed',message,hashes});
      if(hashes.length)recordTrade({
        side,token:{chainKey:'near',address:token.tokenAddress,symbol:token.symbol,name:token.name,imageUrl:token.imageUrl??null},
        pay:{amount,symbol:side==='buy'?'USDC':token.symbol,chainKey:'near'},
        receive:{amount:null,symbol:side==='buy'?token.symbol:'USDC',chainKey:'near'},
        txHashes:hashes,chainIds:[],requestId:null,status:'failed',error:message
      });
    }finally{setRunning(false);}
  };

  const closeResult=()=>{setResult(null);if(result?.kind==='success'||result?.kind==='partial'||result?.kind==='refunded'){setAmount('');setQuote(null);}};

  return <View style={styles.container}>
    <TokenChartPanel token={token}/>
    <View style={styles.tokenLine}>
      {token.imageUrl?<Image source={{uri:token.imageUrl}} style={styles.icon}/>:<View style={styles.icon}><Text style={styles.letter}>{token.symbol.slice(0,1)}</Text></View>}
      <View style={styles.flex}><Text style={styles.symbol}>{token.symbol}</Text><Text style={styles.muted}>NEAR · {wallet.nearAddress?wallet.nearAddress.slice(0,8)+'…'+wallet.nearAddress.slice(-6):'account unavailable'}</Text></View>
    </View>
    <View style={styles.sides}>
      <Pressable onPress={()=>{setSide('buy');setAmount('');}} style={[styles.side,side==='buy'&&styles.buy]}><Text style={styles.sideText}>↑ Buy</Text></Pressable>
      <Pressable onPress={()=>{setSide('sell');setAmount('');}} style={[styles.side,side==='sell'&&styles.sell]}><Text style={styles.sideText}>↓ Sell</Text></Pressable>
    </View>
    <View style={styles.presets}>{[25,50,75,100].map(p=><Pressable key={p} onPress={()=>choosePreset(p)} disabled={available<=0} style={styles.preset}><Text style={styles.presetText}>{p===100?'MAX':p+'%'}</Text></Pressable>)}</View>
    <View style={styles.card}>
      <Text style={styles.label}>YOU PAY</Text>
      <View style={styles.inputRow}><View style={styles.asset}><Text style={styles.assetSymbol}>{side==='buy'?'USDC':token.symbol}</Text><Text style={styles.muted}>NEAR</Text></View><TextInput value={amount} onChangeText={v=>setAmount(v.replace(',','.'))} keyboardType="decimal-pad" placeholder="0" placeholderTextColor={c.textMuted} style={styles.amount}/></View>
      <Text style={styles.avail}>{available>0?formatAvailable(available):'0'} available</Text>
    </View>
    <View style={styles.card}>
      <Text style={styles.label}>YOU RECEIVE</Text>
      <View style={styles.inputRow}><View style={styles.asset}><Text style={styles.assetSymbol}>{side==='buy'?token.symbol:'USDC'}</Text><Text style={styles.muted}>NEAR</Text></View>{loading?<ActivityIndicator color={c.accent}/>:<Text style={styles.receive}>{receiveAmount==null?'—':formatAvailable(receiveAmount)}</Text>}</View>
      {minimum!=null?<Text style={styles.avail}>Minimum received {formatAvailable(minimum)}</Text>:null}
    </View>
    <View style={styles.feeRow}><View style={styles.dot}/><Text style={styles.fee}>Fee {fee?formatAvailable(fee)+' USDC':'—'}</Text><Text style={styles.muted}> · Gas free · NEAR</Text></View>
    {quote&&<View style={styles.details}><Row label="Minimum received" value={minimum==null?'—':formatAvailable(minimum)+' '+(side==='buy'?token.symbol:'USDC')}/><Row label="Route" value={quote.stages?'2-step route':'NEAR DEX'}/><Row label="Slippage" value={(quote.slippageBps/100)+'%'}/><Row label="You sign" value="Once"/></View>}
    {error?<Text style={styles.error}>{error}</Text>:null}
    {insufficient?<Text style={styles.error}>Insufficient {side==='buy'?'USDC on NEAR':token.symbol}.</Text>:belowMin?<Text style={styles.error}>The minimum trade is ${MIN_TRADE_USD}.</Text>:null}
    <Pressable disabled={!quote||running||insufficient||belowMin} onPress={execute} style={[styles.button,(!quote||running||insufficient||belowMin)&&styles.disabled]}><Text style={styles.buttonText}>{running?(funding?'Moving USDC to NEAR…':'Processing…'):(side==='buy'?'Buy ':'Sell ')+token.symbol}</Text></Pressable>

    <KivoModal visible={!!result} transparent animationType="fade" onRequestClose={closeResult}>
      <View style={styles.backdrop}><View style={styles.resultCard}>
        <View style={[styles.resultIcon, result?.kind==='failed'||result?.kind==='refunded'?styles.resultBad:styles.resultGood]}><Text style={styles.resultIconText}>{result?.kind==='failed'?'!':result?.kind==='refunded'?'↩':'✓'}</Text></View>
        <Text style={styles.resultTitle}>{result?.kind==='success'?side==='buy'?`Bought ${token.symbol}`:`Sold ${token.symbol}`:result?.kind==='partial'?'Trade partially filled':result?.kind==='refunded'?'Trade refunded':'Trade failed'}</Text>
        <Text style={styles.resultMessage}>{result?.message}</Text>
        {result?.hashes.map((hash,i)=><Pressable key={hash} onPress={()=>Linking.openURL(`https://nearblocks.io/txns/${hash}`)}><Text style={styles.hash}>{result.hashes.length>1?`Transaction ${i+1}: `:''}{hash.slice(0,10)}…{hash.slice(-6)}</Text></Pressable>)}
        <Pressable onPress={()=>{closeResult();onOpenHistory?.();}} style={styles.done}><Text style={styles.doneText}>Done</Text></Pressable>
      </View></View>
    </KivoModal>
  </View>;
}
function formatAvailable(n:number){return n>=1000?n.toLocaleString(undefined,{maximumFractionDigits:2}):n.toLocaleString(undefined,{maximumFractionDigits:6});}
function Row({label,value}:{label:string;value:string}){return <View style={styles.row}><Text style={styles.muted}>{label}</Text><Text style={styles.value}>{value}</Text></View>;}
const c=kivoTheme.colors;
const styles=StyleSheet.create({
 container:{backgroundColor:c.background,paddingTop:8,paddingBottom:24},
 tokenLine:{flexDirection:'row',alignItems:'center',gap:10,paddingVertical:10},icon:{width:42,height:42,borderRadius:21,backgroundColor:c.surface,alignItems:'center',justifyContent:'center'},letter:{color:c.text,fontWeight:'900',fontSize:16},flex:{flex:1},symbol:{color:c.text,fontSize:16,fontWeight:'900'},muted:{color:c.textMuted,fontSize:11},sides:{flexDirection:'row',gap:8,marginTop:8},side:{flex:1,height:44,borderRadius:999,backgroundColor:c.surface,alignItems:'center',justifyContent:'center'},buy:{backgroundColor:c.cream},sell:{backgroundColor:c.surfaceRaised,borderWidth:1,borderColor:c.danger},sideText:{color:c.text,fontWeight:'900'},presets:{flexDirection:'row',gap:7,marginTop:10},preset:{flex:1,height:34,borderRadius:10,backgroundColor:c.surface,alignItems:'center',justifyContent:'center',borderWidth:1,borderColor:c.border},presetText:{color:c.textMuted,fontSize:10,fontWeight:'800'},card:{marginTop:10,padding:14,borderRadius:14,backgroundColor:c.surface,borderWidth:1,borderColor:c.border},label:{color:c.textMuted,fontSize:10,fontWeight:'800',letterSpacing:1},inputRow:{flexDirection:'row',alignItems:'center',marginTop:9,gap:10},asset:{minWidth:78},assetSymbol:{color:c.text,fontSize:14,fontWeight:'900'},amount:{flex:1,color:c.text,fontSize:28,fontWeight:'800',textAlign:'right',paddingVertical:2},receive:{flex:1,color:c.text,fontSize:22,fontWeight:'800',textAlign:'right'},avail:{color:c.textMuted,fontSize:10.5,marginTop:5},feeRow:{flexDirection:'row',alignItems:'center',marginTop:10,gap:4},dot:{width:7,height:7,borderRadius:4,backgroundColor:c.success},fee:{color:c.text,fontSize:11,fontWeight:'800'},details:{marginTop:8,padding:12,borderRadius:12,backgroundColor:c.surface},row:{flexDirection:'row',justifyContent:'space-between',paddingVertical:4},value:{color:c.text,fontSize:11,fontWeight:'700'},error:{color:c.danger,fontSize:11.5,lineHeight:17,marginTop:9},button:{marginTop:14,height:52,borderRadius:26,backgroundColor:c.cream,alignItems:'center',justifyContent:'center'},buttonText:{color:c.backgroundDeep,fontWeight:'900',fontSize:15},disabled:{opacity:.4},backdrop:{flex:1,backgroundColor:'rgba(0,0,0,.55)',justifyContent:'center',padding:30},resultCard:{backgroundColor:c.surface,borderColor:c.border,borderWidth:1,borderRadius:18,padding:20,alignItems:'center'},resultIcon:{width:54,height:54,borderRadius:27,alignItems:'center',justifyContent:'center',marginBottom:10},resultGood:{backgroundColor:c.success},resultBad:{backgroundColor:c.danger},resultIconText:{color:c.backgroundDeep,fontSize:28,fontWeight:'900'},resultTitle:{color:c.text,fontSize:16,fontWeight:'900',textAlign:'center'},resultMessage:{color:c.textMuted,fontSize:12,lineHeight:18,textAlign:'center',marginTop:5},hash:{color:c.accent,fontSize:11,fontWeight:'700',marginTop:10},done:{alignSelf:'stretch',height:46,borderRadius:12,backgroundColor:c.cream,alignItems:'center',justifyContent:'center',marginTop:16},doneText:{color:c.backgroundDeep,fontWeight:'900'}
});
