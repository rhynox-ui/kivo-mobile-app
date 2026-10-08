import React, {useEffect, useState} from 'react';
import {ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {parseUnits} from 'viem';
import {kivoTheme} from '../theme/kivoTheme';
import {CHAIN_LABEL, NEAR_ENABLED, NEAR_LABEL, NEAR_USDC, NEAR_USDC_DECIMALS, assetDecimalsForChain, currencyAddress, type ChainKey} from '@kivo/trading/core/chainData';
import {getRelayQuote, summarizeQuote, type QuoteSummary} from '@kivo/trading/core/relayQuote';
import {executeRelayQuote, type ExecuteStep} from '@kivo/trading/core/executeRelayQuote';
import {fetchCashBalances, type CashBalanceRow} from '@kivo/trading/kivo/balances';
import {USDC_CHAINS, formatUsd} from '@kivo/trading/kivo/tokens';
import {getWalletSession, withDeviceAccounts, type WalletSession} from '../state/walletStore';
import type {DerivedAccounts} from '@kivo/trading/wallet/keys';
import {fetchNearTokenBalance} from '@kivo/trading/core/nearTrade';
import {nearCashMoveChains, nearCashMoveRequest, nearUsdcDepositCall} from '@kivo/trading/core/nearCashMoves';
import {fetchOneClickStatus, fetchOneClickTokens, requestOneClickQuote, submitOneClickDepositTx} from '@kivo/trading/core/oneClick';
import {fundOneClickQuote, refreshOneClickSwap, shouldPollOneClickSwap, type OneClickSwapRecord} from '@kivo/trading/core/oneClickDeposits';
import {oneClickSwapStore} from '@kivo/trading/wallet/oneClickSwapStore';
import {nearView} from '@kivo/trading/core/nearRpc';

type CashChain = ChainKey | 'near';
const balanceFor=(rows:CashBalanceRow[]|null,chain:ChainKey)=>{const r=rows?.find(x=>x.chainKey===chain);return r?.status==='ok'?r.balance.amount:0;};
const chainLabel=(chain:CashChain)=>chain==='near'?NEAR_LABEL:CHAIN_LABEL[chain];
const decimalsFor=(chain:CashChain)=>chain==='near'?NEAR_USDC_DECIMALS:(assetDecimalsForChain(chain,'USDC')??6);
const glyph=(chain:ChainKey)=>({ethereum:'◆',base:'■',avalanche:'▲',arbitrum:'◎',unichain:'✦',solana:'≋',bnb:'⬡',hyperevm:'●',ink:'◉',abstract:'✣',xlayer:'▦',arc:'◒',robinhood:'◈',stable:'◇',plasma:'▣'} as Partial<Record<ChainKey,string>>)[chain]??'•';

export function ConvertCashSheet({visible,onClose,onConverted}:{visible:boolean;onClose:()=>void;onConverted:()=>void}){
 const [wallet,setWallet]=useState<WalletSession|null>(getWalletSession());
 const [rows,setRows]=useState<CashBalanceRow[]|null>(null);
 const [from,setFrom]=useState<CashChain>('base'); const [to,setTo]=useState<CashChain>('solana');
 const [picker,setPicker]=useState<'from'|'to'|null>(null); const [amount,setAmount]=useState('');
 const [quote,setQuote]=useState<QuoteSummary|null>(null); const [loading,setLoading]=useState(false);
 const [error,setError]=useState<string|null>(null); const [execute,setExecute]=useState<ExecuteStep|null>(null); const [hashes,setHashes]=useState<string[]|null>(null);
 const [nearBalance,setNearBalance]=useState(0); const [nearRecord,setNearRecord]=useState<OneClickSwapRecord|null>(null); const [nearSending,setNearSending]=useState(false);
 const chains=[...new Set([...USDC_CHAINS,'solana',...(NEAR_ENABLED?nearCashMoveChains():[])])] as CashChain[];
 const refresh=()=>{const w=getWalletSession();setWallet(w);if(w){fetchCashBalances(w.address,[...USDC_CHAINS,'solana']).then(setRows).catch(()=>setRows([])); if(w.nearAddress) fetchNearTokenBalance(NEAR_USDC,w.nearAddress).then(v=>setNearBalance(Number(v)/10**NEAR_USDC_DECIMALS)).catch(()=>setNearBalance(0));}};
 useEffect(()=>{if(!visible)return;setAmount('');setQuote(null);setError(null);setHashes(null);setPicker(null);setNearRecord(null);refresh();},[visible]);
 useEffect(()=>{if(!nearRecord||!shouldPollOneClickSwap(nearRecord))return;const t=setTimeout(()=>{refreshOneClickSwap(nearRecord,{fetchStatus:d=>fetchOneClickStatus(d),store:oneClickSwapStore}).then(next=>{setNearRecord(next);if(next.status==='SUCCESS'||next.status==='REFUNDED')onConverted();}).catch(()=>{});},5000);return()=>clearTimeout(t);},[nearRecord,onConverted]);
 const balance=from==='near'?nearBalance:balanceFor(rows,from); const n=Number(amount)||0; const same=from===to; const insufficient=(from==='near'||rows!==null)&&n>balance; const decimals=decimalsFor(from);
 useEffect(()=>{if(!visible||!wallet||same||n<=0||insufficient){setQuote(null);setLoading(false);return;} const t=setTimeout(async()=>{setLoading(true);setError(null);try{
   const amountBaseUnits=parseUnits(amount,decimals).toString();
   if(from==='near'||to==='near'){
     if(!wallet.nearAddress) throw new Error('NEAR account is unavailable.');
     const publicSession={evm:{address:wallet.address,privateKey:''},solana:{address:wallet.solanaAddress??'',privateKey:''},near:{address:wallet.nearAddress,privateKey:''},authMethod:'seed'} as DerivedAccounts;
     const tokens=await fetchOneClickTokens();
     const move=nearCashMoveRequest({direction:from==='near'?'from-near':'to-near',chainKey:(from==='near'?to:from) as ChainKey,amountBaseUnits,session:publicSession,tokens,dry:true});
     const response=await requestOneClickQuote(move.request);
     setQuote({totalFeeUsd:null,etaSeconds:response.quote.timeEstimate??null,receivedAmountFormatted:response.quote.amountOutFormatted??null,payAmountUsd:Number(response.quote.amountInUsd)||null,receiveAmountUsd:Number(response.quote.amountOutUsd)||null,priceImpactPct:null});
   } else {
     const user=from==='solana'?wallet.solanaAddress:wallet.address; const recipient=to==='solana'?wallet.solanaAddress:wallet.address; if(!user||!recipient)throw new Error('Selected wallet address is unavailable.');
     const q=await getRelayQuote({fromChainKey:from as ChainKey,toChainKey:to as ChainKey,originCurrency:currencyAddress(from as ChainKey,'USDC'),destinationCurrency:currencyAddress(to as ChainKey,'USDC'),amountBaseUnits, userAddress:user,recipientAddress:recipient,originAmountUsd:n,waiveAppFee:true});
     setQuote(summarizeQuote(q,assetDecimalsForChain(to as ChainKey,'USDC')??6));
   }
 }catch(e){setQuote(null);setError(e instanceof Error?e.message:'Could not get a conversion rate.');}finally{setLoading(false);}},450);return()=>clearTimeout(t);},[visible,wallet?.address,wallet?.solanaAddress,wallet?.nearAddress,from,to,amount,n,same,insufficient,decimals]);
 const convert=async()=>{if(!quote||!wallet||same||n<=0||insufficient||execute||nearSending)return;setError(null);setHashes(null);try{
   if(from==='near'||to==='near'){
     setNearSending(true);
     await withDeviceAccounts('Confirm Convert',async accounts=>{
       const session=accounts.relay;
       const tokens=await fetchOneClickTokens();
       const move=nearCashMoveRequest({direction:from==='near'?'from-near':'to-near',chainKey:(from==='near'?to:from) as ChainKey,amountBaseUnits:parseUnits(amount,decimals).toString(),session,tokens,dry:false});
       const response=await requestOneClickQuote(move.request);
       const originDecimals=from==='near'?NEAR_USDC_DECIMALS:decimalsFor(from);
       const fromAddress=from==='near'?session.near!.address:(from==='solana'?session.solana.address:session.evm.address);
       const record=await fundOneClickQuote({response,expected:move.expected,originChainKey:from==='near'?'near':from as ChainKey,originSymbol:'USDC',originDecimals,fromAddress,store:oneClickSwapStore,submitDepositTx:(txHash,depositAddress)=>submitOneClickDepositTx(txHash,depositAddress),send:async(toAddress,sendAmount)=>{
         if(from==='near'){const call=await nearUsdcDepositCall(toAddress,parseUnits(sendAmount,NEAR_USDC_DECIMALS),nearView);const [outcome]=await import('@kivo/trading/core/nearSigning').then(m=>m.sendSponsoredNearCalls(session,[call]));return outcome.hash;}
         const {withdrawUsdc}=await import('@kivo/trading/kivo/cash'); return (await withdrawUsdc(from as ChainKey,accounts.evm,accounts.solana,toAddress,sendAmount)).hash;
       }});
       setNearRecord(record);setHashes(record.depositTxHash?[record.depositTxHash]:[]);setNearSending(false);refresh();onConverted();
     });
     return;
   }
   const result=await withDeviceAccounts('Confirm Convert',async session=>{const user=from==='solana'?session.solana.publicKey.toBase58():session.evm.address;const recipient=to==='solana'?session.solana.publicKey.toBase58():session.evm.address;
     const q=await getRelayQuote({fromChainKey:from as ChainKey,toChainKey:to as ChainKey,originCurrency:currencyAddress(from as ChainKey,'USDC'),destinationCurrency:currencyAddress(to as ChainKey,'USDC'),amountBaseUnits:parseUnits(amount,decimals).toString(),userAddress:user,recipientAddress:recipient,originAmountUsd:n,waiveAppFee:true});
     return executeRelayQuote(q,session.relay,s=>setExecute(s),{useGaslessTrading:false});});
   setHashes(result.txHashes);setExecute(null);refresh();onConverted();
 }catch(e){setExecute(null);setNearSending(false);setError(e instanceof Error?e.message:'Conversion failed. Nothing was confirmed.');}};
 if(!visible)return null;
 return <View style={s.overlay}><Pressable style={s.dismiss} onPress={onClose}/><View style={s.sheet}><View style={s.handle}/>
 {picker?<><View style={s.header}><Pressable onPress={()=>setPicker(null)}><Text style={s.back}>‹ Back</Text></Pressable><Text style={s.title}>Convert {picker==='from'?'from':'to'}</Text><View style={{width:40}}/></View><ScrollView style={s.list}>
 {chains.filter(c=>c!==(picker==='from'?to:from)).map(c=><Pressable key={c} style={s.network} onPress={()=>{picker==='from'?setFrom(c):setTo(c);setAmount('');setPicker(null);}}><View style={s.left}><View style={s.icon}><Text style={s.glyph}>{glyph(c)}</Text></View><Text style={s.networkText}>USDC · {chainLabel(c)}</Text></View><Text style={s.networkBalance}>{formatUsd(balanceFor(rows,c))}</Text></Pressable>)}</ScrollView></>
 :<><View style={s.header}><Text style={s.title}>Convert</Text><View style={s.free}><Text style={s.freeText}>Kivo fee: Free</Text></View></View>
 <View style={s.asset}><View style={s.top}><Text style={s.muted}>FROM</Text><Text style={s.muted}>Available: {formatUsd(balance)}</Text></View><View style={s.main}><Pressable style={s.selector} onPress={()=>setPicker('from')}><View style={s.icon}><Text style={s.glyph}>{glyph(from)}</Text></View><Text style={s.symbol}>USDC</Text><Text style={s.chev}>⌄</Text></Pressable><TextInput value={amount} onChangeText={setAmount} placeholder='0' placeholderTextColor={kivoTheme.colors.textMuted} keyboardType='decimal-pad' style={s.amount}/></View><View style={s.bottom}><Text style={s.muted}>{chainLabel(from)}</Text><Pressable onPress={()=>setAmount(String(Math.floor(balance*1e6)/1e6))}><Text style={s.max}>Max</Text></Pressable></View></View>
 <View style={s.swapWrap}><Pressable style={s.swap} onPress={()=>{const x=from;setFrom(to);setTo(x);setAmount('');}}><Text style={s.swapText}>⇅</Text></Pressable></View>
 <View style={s.asset}><View style={s.top}><Text style={s.muted}>TO</Text><Text style={s.muted}>Available: {formatUsd(balanceFor(rows,to))}</Text></View><View style={s.main}><Pressable style={s.selector} onPress={()=>setPicker('to')}><View style={s.icon}><Text style={s.glyph}>{glyph(to)}</Text></View><Text style={s.symbol}>USDC</Text><Text style={s.chev}>⌄</Text></Pressable>{loading?<ActivityIndicator color={kivoTheme.colors.textMuted}/>:<Text style={s.receive}>{quote?.receivedAmountFormatted??'0'}</Text>}</View><Text style={s.muted}>{chainLabel(to)}</Text></View>
 {error&&<Text style={s.error}>{error}</Text>}{hashes&&<View style={s.success}><Text style={s.successText}>Converted successfully</Text>{hashes.map(h=><Text key={h} style={s.hash} numberOfLines={1}>{h}</Text>)}</View>}
 <Pressable disabled={!quote||same||n<=0||insufficient||!!execute} onPress={convert} style={[s.button,(!quote||same||n<=0||insufficient||!!execute)&&s.disabled]}><Text style={s.buttonText}>{nearSending?'Sending…':execute?'Converting…':!amount?'Enter an amount':insufficient?'Insufficient USDC balance':same?'Pick two different networks':loading?'Finding rate…':quote?'Convert':'Finding rate…'}</Text></Pressable><Pressable onPress={onClose} style={s.cancel}><Text style={s.cancelText}>Cancel</Text></Pressable></>}</View></View>;
}
const c=kivoTheme.colors; const s=StyleSheet.create({
overlay:{...StyleSheet.absoluteFill,zIndex:100,justifyContent:'flex-end'},dismiss:{...StyleSheet.absoluteFill,backgroundColor:'rgba(0,0,0,.72)'},sheet:{backgroundColor:c.surface,borderTopLeftRadius:26,borderTopRightRadius:26,padding:20,paddingBottom:34,maxHeight:'90%',borderWidth:1,borderColor:c.border},handle:{width:48,height:5,borderRadius:3,backgroundColor:c.border,alignSelf:'center',marginBottom:14},
header:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',marginBottom:16},title:{color:c.text,fontSize:20,fontWeight:'900'},back:{color:c.textMuted,fontWeight:'700'},free:{backgroundColor:c.surfaceRaised,borderRadius:999,paddingHorizontal:10,paddingVertical:6},freeText:{color:c.success,fontSize:11,fontWeight:'800'},
asset:{backgroundColor:c.surfaceRaised,borderRadius:16,padding:14,gap:8},top:{flexDirection:'row',justifyContent:'space-between'},muted:{color:c.textMuted,fontSize:11,fontWeight:'700'},main:{flexDirection:'row',alignItems:'center',justifyContent:'space-between'},selector:{flexDirection:'row',alignItems:'center',gap:6},icon:{width:30,height:30,borderRadius:15,backgroundColor:c.surface,alignItems:'center',justifyContent:'center'},glyph:{color:c.text,fontWeight:'900'},symbol:{color:c.text,fontSize:16,fontWeight:'900'},chev:{color:c.textMuted},amount:{flex:1,textAlign:'right',color:c.text,fontSize:25,fontWeight:'800',padding:0,marginLeft:12},receive:{color:c.text,fontSize:24,fontWeight:'800',maxWidth:'55%',textAlign:'right'},bottom:{flexDirection:'row',justifyContent:'space-between'},max:{color:c.cream,fontWeight:'900'},
swapWrap:{alignItems:'center',marginVertical:-12,zIndex:2},swap:{width:34,height:34,borderRadius:17,backgroundColor:c.surface,borderWidth:1,borderColor:c.border,alignItems:'center',justifyContent:'center'},swapText:{color:c.text,fontSize:17},error:{color:c.danger,fontSize:12,lineHeight:18,marginTop:10},success:{marginTop:10,gap:3},successText:{color:c.success,fontWeight:'800'},hash:{color:c.textMuted,fontSize:10},button:{height:52,borderRadius:26,backgroundColor:c.accent,alignItems:'center',justifyContent:'center',marginTop:16},buttonText:{color:c.backgroundDeep,fontWeight:'900',fontSize:15},disabled:{opacity:.45},list:{maxHeight:500},network:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',backgroundColor:c.surfaceRaised,borderRadius:15,padding:13,marginBottom:8},left:{flexDirection:'row',alignItems:'center',gap:10,flex:1},networkText:{color:c.text,fontWeight:'800'},networkBalance:{color:c.textMuted,fontWeight:'700',fontSize:12},cancel:{height:44,alignItems:'center',justifyContent:'center'},cancelText:{color:c.cream,fontWeight:'800'}
});