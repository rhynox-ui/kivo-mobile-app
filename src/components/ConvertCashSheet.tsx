import {kivoTheme} from '../theme/kivoTheme';
import React, {useEffect, useRef, useState} from 'react';
import {ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {transactionLink} from '@kivo/trading/kivo/execute';
import {NetworkIcon} from '../wallet/NetworkIcon';
import {BottomSheet} from './BottomSheet';
import {ResultCard, splitError} from './ResultCard';
import {normalizeAmountInput} from '../utils/amountInput';
import {parseUnits} from 'viem';
import {CHAIN_LABEL, MAINNET_CHAIN_IDS, NEAR_ENABLED, NEAR_LABEL, NEAR_USDC, NEAR_USDC_DECIMALS, type ChainKey} from '@kivo/trading/core/chainData';
import {getRelayQuote, summarizeQuote, type QuoteSummary} from '@kivo/trading/core/relayQuote';
import {executeRelayQuote, getPartialTxHashes, type ExecuteStep} from '@kivo/trading/core/executeRelayQuote';
import {clearCashBalanceCache, readTokenBalance} from '@kivo/trading/kivo/balances';
import {fetchPortfolio} from '@kivo/trading/kivo/portfolio';
import {getTradeHistory} from '@kivo/trading/kivo/history';
import {clearSpendableBalanceCache, fetchSpendableBalance, type SpendableAsset, type SpendableBalance} from '@kivo/trading/kivo/spendable';
import {convertQuoteParams, convertSources, convertTargets, sameAsset, type ConvertAsset} from '@kivo/trading/kivo/convert';
import {recordTrade} from '@kivo/trading/kivo/history';
import {markOwnAction} from '../wallet/depositWatcher';
import {formatAmount, formatBalanceUsd, formatUsd, shortAddress} from '@kivo/trading/kivo/tokens';
import {getWalletSession, withDeviceAccounts, type WalletSession} from '../state/walletStore';
import type {DerivedAccounts} from '@kivo/trading/wallet/keys';
import {fetchNearTokenBalance} from '@kivo/trading/core/nearTrade';
import {nearCashMoveChains, nearCashMoveRequest, nearUsdcDepositCall} from '@kivo/trading/core/nearCashMoves';
import {fetchOneClickStatus, fetchOneClickTokens, requestOneClickQuote, submitOneClickDepositTx} from '@kivo/trading/core/oneClick';
import {fundOneClickQuote, refreshOneClickSwap, shouldPollOneClickSwap, type OneClickSwapRecord} from '@kivo/trading/core/oneClickDeposits';
import {oneClickSwapStore} from '@kivo/trading/wallet/oneClickSwapStore';
import {describeQuoteError} from '@kivo/trading/kivo/quote';
import {nearView} from '@kivo/trading/core/nearRpc';

type CashChain = ChainKey | 'near';
/** One side of a conversion: an asset on a network, or USDC on NEAR (moved through NEAR Intents). */
type Side = {id: string; chain: CashChain; symbol: string; decimals: number; asset: ConvertAsset | null; spendableAmount: number; priceUsd: number; valueUsd: number};
let oneClickTokensPromise: ReturnType<typeof fetchOneClickTokens> | null = null;
const cachedOneClickTokens = () => oneClickTokensPromise ??= fetchOneClickTokens().catch(error => { oneClickTokensPromise = null; throw error; });
const chainLabel=(chain:CashChain)=>chain==='near'?NEAR_LABEL:CHAIN_LABEL[chain];
const NEAR_ID='near:usdc';
const nearSide=(amount:number):Side=>({id:NEAR_ID,chain:'near',symbol:'USDC',decimals:NEAR_USDC_DECIMALS,asset:null,spendableAmount:amount,priceUsd:1,valueUsd:amount});
const sideFromSpendable=(a:SpendableAsset):Side=>({id:`${a.chainKey}:${a.address}`,chain:a.chainKey,symbol:a.symbol,decimals:a.decimals,asset:{chainKey:a.chainKey,address:a.address,symbol:a.symbol,decimals:a.decimals,kind:a.kind},spendableAmount:a.spendableAmount,priceUsd:a.priceUsd,valueUsd:a.valueUsd});
const sideFromTarget=(t:ConvertAsset,held:SpendableAsset|undefined):Side=>({id:`${t.chainKey}:${t.address}`,chain:t.chainKey,symbol:t.symbol,decimals:t.decimals,asset:t,spendableAmount:held?.spendableAmount??0,priceUsd:held?.priceUsd??0,valueUsd:held?.valueUsd??0});
/** NEAR only moves cash: USDC on NEAR <-> USDC on a network NEAR Intents supports. */
const nearProblem=(from:Side,to:Side):string|null=>{if(from.chain!=='near'&&to.chain!=='near')return null;const other=from.chain==='near'?to:from;if(other.chain==='near')return 'Pick two different networks.';if(other.asset?.kind!=='cash'||other.symbol!=='USDC'||!nearCashMoveChains().includes(other.chain as ChainKey))return 'NEAR converts USDC only, to or from USDC on another network.';return null;};

export function ConvertCashSheet({visible,onClose,onConverted}:{visible:boolean;onClose:()=>void;onConverted:()=>void}){
 const [wallet,setWallet]=useState<WalletSession|null>(getWalletSession());
 const [balance,setBalance]=useState<SpendableBalance|null>(null);
 const [nearBalance,setNearBalance]=useState(0);
 // Every other token the wallet holds (memecoins etc.), with on-chain decimals and balance.
 const [heldTokens,setHeldTokens]=useState<Side[]>([]);
 const [fromId,setFromId]=useState<string|null>(null); const [toId,setToId]=useState<string|null>(null);
 const [picker,setPicker]=useState<'from'|'to'|null>(null); const [amount,setAmount]=useState('');
 const [quote,setQuote]=useState<QuoteSummary|null>(null); const [loading,setLoading]=useState(false); const rawQuoteRef=React.useRef<Awaited<ReturnType<typeof getRelayQuote>>|null>(null); const lastQuoteParamsRef=React.useRef<Parameters<typeof getRelayQuote>[0]|null>(null); const quoteRequestIdRef=React.useRef(0);
 const [error,setError]=useState<string|null>(null); const [execute,setExecute]=useState<ExecuteStep|null>(null); const [hashes,setHashes]=useState<string[]|null>(null);
 const [nearRecord,setNearRecord]=useState<OneClickSwapRecord|null>(null);const[relayStatus,setRelayStatus]=useState<'success'|'pending'|'refunded'|null>(null);const busyRef=useRef(false); const [nearSending,setNearSending]=useState(false);
 const [sent,setSent]=useState<{paid:string;received:string|null}|null>(null);
 // Set once a conversion was attempted: the sheet then shows the result card.
 const [outcome,setOutcome]=useState<{tone:'success'|'pending'|'error';from:Side;to:Side;message?:string}|null>(null);
 const hasSolana=Boolean(wallet?.solanaAddress);
 // Sources: everything spendable, largest first (plus NEAR USDC). Targets: cash on every network and each network's own coin.
 const spendableSources:Side[]=[...convertSources(balance?.assets??[]).map(sideFromSpendable),...(NEAR_ENABLED&&nearBalance>0?[nearSide(nearBalance)]:[])];
 const sources:Side[]=[...spendableSources,...heldTokens.filter(t=>!spendableSources.some(x=>x.id===t.id))].sort((a,b)=>b.valueUsd-a.valueUsd);
 const baseTargets:Side[]=[...convertTargets({hasSolana}).map(t=>sideFromTarget(t,balance?.assets.find(a=>sameAsset(a,t)))),...(NEAR_ENABLED&&wallet?.nearAddress?[nearSide(nearBalance)]:[])];
 const targets:Side[]=[...baseTargets,...heldTokens.filter(t=>!baseTargets.some(x=>x.id===t.id))];
 // Either side can hold any asset, so ⇅ always swaps (an empty source just shows 0 available).
 const sideById=(id:string|null)=>id?sources.find(x=>x.id===id)??targets.find(x=>x.id===id)??null:null;
 const from=sideById(fromId); const to=sideById(toId);
 const loadHeldTokens=(w:WalletSession,forceFresh:boolean)=>{fetchPortfolio(w.address,getTradeHistory(),{solanaAddress:w.solanaAddress},{forceFresh}).then(async portfolio=>{
   const held=portfolio.holdings.filter(x=>x.kind==='token'&&x.chainKey!=='near'&&(x.chainKey!=='solana'||w.solanaAddress)&&(x.valueUsd??0)>=0.01);
   const read=await Promise.allSettled(held.map(x=>readTokenBalance(x.chainKey as ChainKey,x.address,x.chainKey==='solana'?w.solanaAddress!:w.address,x.symbol)));
   setHeldTokens(held.flatMap((x,i)=>{const r=read[i];if(r.status!=='fulfilled'||!(r.value.amount>0))return[];const price=x.priceUsd??0;const asset:ConvertAsset={chainKey:x.chainKey as ChainKey,address:x.address,symbol:x.symbol,decimals:r.value.decimals,kind:'token'};return[{id:`${x.chainKey}:${x.address}`,chain:x.chainKey as ChainKey,symbol:x.symbol,decimals:r.value.decimals,asset,spendableAmount:r.value.amount,priceUsd:price,valueUsd:r.value.amount*price}];}));
 }).catch(()=>setHeldTokens([]));};
 const refresh=(forceFresh=false)=>{const w=getWalletSession();setWallet(w);if(w)loadHeldTokens(w,forceFresh);if(w){fetchSpendableBalance(w.address,w.source==='local'?w.solanaAddress:undefined,{forceFresh}).then(setBalance).catch(()=>setBalance({assets:[],errors:[]})); if(w.nearAddress) fetchNearTokenBalance(NEAR_USDC,w.nearAddress).then(v=>setNearBalance(Number(v)/10**NEAR_USDC_DECIMALS)).catch(()=>setNearBalance(0));}};
 useEffect(()=>{if(!visible)return;setAmount('');setQuote(null);rawQuoteRef.current=null;lastQuoteParamsRef.current=null;setError(null);setHashes(null);setSent(null);setPicker(null);setNearRecord(null);setOutcome(null);setFromId(null);setToId(null);refresh();},[visible]);
 // Defaults once balances arrive: the largest holding, converted to cash on its own network (or cash elsewhere when it already is cash).
 useEffect(()=>{if(!visible||fromId||!balance)return;const f=spendableSources[0]??sources[0];if(!f)return;setFromId(f.id);const sameChainCash=f.asset&&f.asset.kind!=='cash'?targets.find(t=>t.chain===f.chain&&t.asset?.kind==='cash'):undefined;const other=sameChainCash??targets.find(t=>t.id!==f.id&&t.asset?.kind==='cash'&&t.chain===(f.chain==='base'?'solana':'base'))??targets.find(t=>t.id!==f.id);setToId(other?.id??null);},[visible,balance,nearBalance]);
 useEffect(()=>{if(!nearRecord||!shouldPollOneClickSwap(nearRecord))return;const t=setTimeout(()=>{refreshOneClickSwap(nearRecord,{fetchStatus:d=>fetchOneClickStatus(d),store:oneClickSwapStore}).then(next=>{setNearRecord(next);if(next.status==='SUCCESS'||next.status==='REFUNDED')onConverted();}).catch(()=>{});},5000);return()=>clearTimeout(t);},[nearRecord,onConverted]);
 const n=Number(amount)||0; const same=Boolean(from&&to&&from.id===to.id); const decimals=from?.decimals??6;
 const insufficient=Boolean(from)&&n>(from?.spendableAmount??0)+1e-12; const pairProblem=from&&to?nearProblem(from,to):null;
 const cashMove=Boolean(from&&to&&(from.chain==='near'||from.asset?.kind==='cash')&&(to.chain==='near'||to.asset?.kind==='cash'));
 useEffect(()=>{if(!visible||!wallet||!from||!to||same||pairProblem||n<=0||insufficient){setQuote(null);rawQuoteRef.current=null;lastQuoteParamsRef.current=null;setLoading(false);return;} const requestId=++quoteRequestIdRef.current; const t=setTimeout(async()=>{setLoading(true);setError(null);try{
   const amountBaseUnits=parseUnits(amount,decimals).toString();
   if(from.chain==='near'||to.chain==='near'){
     if(!wallet.nearAddress) throw new Error('NEAR account is unavailable.');
     const publicSession: DerivedAccounts = {evm:{address:wallet.address,privateKey:''},solana:{address:wallet.solanaAddress??'',privateKey:''},near:{address:wallet.nearAddress,privateKey:''},authMethod:'seed'};
     const tokens=await cachedOneClickTokens();
     const move=nearCashMoveRequest({direction:from.chain==='near'?'from-near':'to-near',chainKey:(from.chain==='near'?to.chain:from.chain) as ChainKey,amountBaseUnits,session:publicSession,tokens,dry:true});
     const response=await requestOneClickQuote(move.request);
     if(requestId!==quoteRequestIdRef.current)return; rawQuoteRef.current=null;lastQuoteParamsRef.current=null;setQuote({totalFeeUsd:null,etaSeconds:response.quote.timeEstimate??null,receivedAmountFormatted:response.quote.amountOutFormatted??null,payAmountUsd:Number(response.quote.amountInUsd)||null,receiveAmountUsd:Number(response.quote.amountOutUsd)||null,priceImpactPct:null});
   } else {
     const quoteParams=convertQuoteParams({from:from.asset!,to:to.asset!,amountBaseUnits,amountUsd:from.priceUsd>0?n*from.priceUsd:null,evmAddress:wallet.address,solanaAddress:wallet.solanaAddress});
     const q=await getRelayQuote(quoteParams); if(requestId!==quoteRequestIdRef.current)return; rawQuoteRef.current=q; lastQuoteParamsRef.current=quoteParams;
     setQuote(summarizeQuote(q,to.decimals));
   }
 }catch(e){if(requestId!==quoteRequestIdRef.current)return;setQuote(null);rawQuoteRef.current=null;lastQuoteParamsRef.current=null;setError(describeQuoteError(e));}finally{if(requestId===quoteRequestIdRef.current)setLoading(false);}},450);return()=>clearTimeout(t);},[visible,wallet?.address,wallet?.solanaAddress,wallet?.nearAddress,fromId,toId,amount,n,same,insufficient,decimals,pairProblem]);
 const convert=async()=>{if(!quote||!wallet||!from||!to||same||pairProblem||n<=0||insufficient||execute||nearSending||busyRef.current)return;busyRef.current=true;setError(null);setHashes(null);setSent(null);setRelayStatus(null);setNearRecord(null);
 // Converting a held token away is a sell of that token in the trade history (keeps its PnL right).
 const soldToken=from.asset?.kind==='token';
 const tokenInfo=soldToken?{chainKey:from.chain as ChainKey,address:from.asset!.address,symbol:from.symbol,name:from.symbol,imageUrl:null}:{chainKey:to.chain as ChainKey,address:to.asset?.address??NEAR_USDC,symbol:to.symbol,name:to.symbol,imageUrl:null};
 const historySide=soldToken?'sell' as const:'buy' as const;
 try{
   if(from.chain==='near'||to.chain==='near'){
     setNearSending(true);
     await withDeviceAccounts('Confirm Convert',async accounts=>{
       const session=accounts.relay;
       const tokens=await fetchOneClickTokens();
       const move=nearCashMoveRequest({direction:from.chain==='near'?'from-near':'to-near',chainKey:(from.chain==='near'?to.chain:from.chain) as ChainKey,amountBaseUnits:parseUnits(amount,decimals).toString(),session,tokens,dry:false});
       const response=await requestOneClickQuote(move.request);
       const fromAddress=from.chain==='near'?session.near!.address:(from.chain==='solana'?wallet.solanaAddress!:wallet.address);
       const record=await fundOneClickQuote({response,expected:move.expected,originChainKey:from.chain==='near'?'near':from.chain as ChainKey,originSymbol:from.symbol,originDecimals:from.decimals,fromAddress,store:oneClickSwapStore,submitDepositTx:(txHash,depositAddress)=>submitOneClickDepositTx(txHash,depositAddress),send:async(toAddress,sendAmount)=>{
         if(from.chain==='near'){const call=await nearUsdcDepositCall(toAddress,parseUnits(sendAmount,NEAR_USDC_DECIMALS),nearView);const [outcome]=await import('@kivo/trading/core/nearSigning').then(m=>m.sendSponsoredNearCalls(session,[call]));return outcome.hash;}
         const {withdrawUsdc}=await import('@kivo/trading/kivo/cash'); return (await withdrawUsdc(from.chain as ChainKey,accounts.evm,accounts.solana,toAddress,sendAmount)).hash;
       }});
       setNearRecord(record);setOutcome({tone:'pending',from,to});setHashes(record.depositTxHash?[record.depositTxHash]:[]);setSent({paid:`${amount} ${from.symbol}`,received:quote.receivedAmountFormatted?`${quote.receivedAmountFormatted} ${to.symbol}`:null});setNearSending(false);
     });
     return;
   }
   const quoteToExecute=rawQuoteRef.current;
   const quoteParams=lastQuoteParamsRef.current;
   if(!quoteToExecute) throw new Error('The conversion quote is no longer available. Enter the amount again.');
   const result=await withDeviceAccounts('Confirm Convert',async session=>{
     return executeRelayQuote(quoteToExecute,session.relay,s=>setExecute(s),{useGaslessTrading:true,requote:quoteParams?async()=>getRelayQuote(quoteParams):undefined});
   });
   const settled=result.status??'success';setRelayStatus(settled);setOutcome({tone:settled==='success'?'success':settled==='refunded'?'error':'pending',from,to,message:settled==='refunded'?'The route could not be filled, so it was refunded.':undefined});setHashes(result.txHashes);setExecute(null);
   setSent({paid:`${amount} ${from.symbol}`,received:quote.receivedAmountFormatted?`${formatAmount(Number(quote.receivedAmountFormatted))} ${to.symbol}`:null});
   void markOwnAction(wallet.address).catch(()=>{});
   recordTrade({side:historySide,token:tokenInfo,pay:{amount,symbol:from.symbol,chainKey:from.chain as ChainKey},receive:{amount:quote.receivedAmountFormatted??null,symbol:to.symbol,chainKey:to.chain as ChainKey},txHashes:result.txHashes,chainIds:[],requestId:result.requestId??null,status:settled});
 }catch(e){setExecute(null);setNearSending(false);const partial=getPartialTxHashes(e);if(partial.length){setHashes(partial);recordTrade({side:historySide,token:tokenInfo,pay:{amount,symbol:from.symbol,chainKey:from.chain as ChainKey},receive:{amount:null,symbol:to.symbol,chainKey:to.chain as ChainKey},txHashes:partial,chainIds:[],requestId:null,status:'failed',error:e instanceof Error?e.message:'Conversion failed after a transaction was broadcast.'});}setError(e instanceof Error?e.message:'Conversion failed. Nothing was confirmed.');setOutcome({tone:'error',from,to,message:e instanceof Error?e.message:'Conversion failed. Nothing was confirmed.'});}
 finally{busyRef.current=false;
   // Balances changed (or may have): read them fresh.
   clearCashBalanceCache();clearSpendableBalanceCache();refresh(true);onConverted();}};
 if(!visible)return null;
 const fromChainId=from&&from.chain!=='near'?MAINNET_CHAIN_IDS[from.chain as ChainKey]:null;
 const txLinks=(list:string[])=>list.map(h=><Pressable key={h} hitSlop={6} onPress={()=>{Linking.openURL(transactionLink(h,fromChainId)).catch(()=>{});}}><Text style={[s.hash,s.hashLink]} numberOfLines={1}>{shortAddress(h,10,6)}  ↗ View transaction</Text></Pressable>);
 // Both pickers list every asset: what you hold first (largest first), then
 // everything else. Picking the asset already on the other side swaps them.
 const allSides:Side[]=[...sources,...targets.filter(t=>!sources.some(x=>x.id===t.id))];
 const pickList=[...allSides.filter(x=>x.valueUsd>0).sort((a,b)=>b.valueUsd-a.valueUsd),...allSides.filter(x=>!(x.valueUsd>0))];
 const pickSide=(x:Side)=>{const other=picker==='from'?toId:fromId;const mine=picker==='from'?fromId:toId;
   if(picker==='from'){setFromId(x.id);if(other===x.id)setToId(mine);}else{setToId(x.id);if(other===x.id)setFromId(mine);}
   setAmount('');setQuote(null);setError(null);setPicker(null);};
 const usd=(v:number)=>v>0?formatBalanceUsd(v):'';
 const buttonLabel=nearSending?'Sending…':(nearRecord&&shouldPollOneClickSwap(nearRecord))?'Waiting for NEAR Intents…':execute?'Converting…':!from?(balance?'Nothing to convert yet':'Reading balances…'):!to?'Pick what to receive':same?'Pick two different assets':pairProblem?pairProblem:!amount?'Enter an amount':insufficient?`Insufficient ${from.symbol} balance`:loading?'Finding rate…':quote?'Convert':'Finding rate…';
 const explorer=(h:string)=>transactionLink(h,fromChainId);
 if(outcome){const ok=outcome.tone!=='error';const done=nearRecord&&!shouldPollOneClickSwap(nearRecord)&&nearRecord.status==='SUCCESS';const tone=done?'success':outcome.tone;
  return <BottomSheet visible={visible} onClose={onClose}><ResultCard
   tone={tone}
   hero={{symbol:outcome.to.symbol}}
   kicker={tone==='success'?'Converted':tone==='pending'?`Converting to ${outcome.to.symbol}`:'Convert failed'}
   headline={tone==='error'?splitError(outcome.message??'Conversion failed.').headline:tone==='pending'?`${sent?.paid??''} → ${outcome.to.symbol}`:`+${sent?.received??outcome.to.symbol}`}
   subline={ok?`${chainLabel(outcome.from.chain)} → ${chainLabel(outcome.to.chain)}${tone==='pending'?' · about a minute':''}`:undefined}
   reason={tone==='error'?splitError(outcome.message??'').reason:undefined}
   safeNote={tone==='error'?(hashes&&hashes.length?{ok:false,text:'Some transactions were already sent. Check them below before trying again.'}:{ok:true,text:'Nothing was sent. Your balance is unchanged.'}):tone==='pending'?{ok:false,text:'Your funds are on the way. If you close the app, the conversion still finishes.'}:undefined}
   from={ok&&sent?{label:'You sent',symbol:outcome.from.symbol,amount:sent.paid}:undefined}
   to={ok&&sent?{label:tone==='pending'?'You get':'You got',symbol:outcome.to.symbol,amount:sent.received??'—'}:undefined}
   steps={tone==='pending'?[{label:`Sent from ${chainLabel(outcome.from.chain)}`,state:'done'},{label:`Moving to ${chainLabel(outcome.to.chain)}`,state:'now'},{label:`${outcome.to.symbol} arrives in your wallet`,state:'todo'}]:undefined}
   links={hashes&&hashes.length?hashes.map((h,i)=>({label:hashes.length>1?`View ${i+1}`:'View',url:explorer(h)})):undefined}
   primary={tone==='error'?{label:'Try again',onPress:()=>{setOutcome(null);setError(null);setHashes(null);setSent(null);}}:{label:'Done',onPress:onClose}}
   secondary={tone==='error'?{label:'Close',onPress:onClose}:undefined}
  /></BottomSheet>;}
 return <BottomSheet visible={visible} onClose={onClose}><View>
 {picker?<><View style={s.header}><Pressable onPress={()=>setPicker(null)}><Text style={s.back}>‹ Back</Text></Pressable><Text style={s.title}>Convert {picker==='from'?'from':'to'}</Text><View style={{width:40}}/></View><ScrollView style={s.list}>
 {pickList.length===0&&<Text style={s.muted}>{picker==='from'?'No balances to convert yet.':'Nothing to convert to.'}</Text>}
 {pickList.map(x=>{const selected=x.id===(picker==='from'?fromId:toId);const onOtherSide=x.id===(picker==='from'?toId:fromId);return <Pressable key={x.id} style={[s.network,selected&&s.networkSelected]} onPress={()=>pickSide(x)}><View style={s.left}><NetworkIcon chainKey={x.chain} size={24} /><View><Text style={s.networkText}>{x.symbol} · {chainLabel(x.chain)}</Text>{onOtherSide?<Text style={s.networkSub}>{picker==='from'?'Selected to receive · tap to swap':'Selected to send · tap to swap'}</Text>:null}</View></View><View style={s.right}>{x.valueUsd>0?<><Text style={s.networkBalance}>{formatUsd(x.valueUsd)}</Text><Text style={s.networkSub}>{formatAmount(x.spendableAmount)} {x.symbol}</Text></>:<Text style={s.networkSub}>{selected?'✓':'0'}</Text>}</View></Pressable>;})}</ScrollView></>
 :<><View style={s.header}><Text style={s.title}>Convert</Text><View style={s.free}><Text style={s.freeText}>{cashMove?'Kivo fee: Free':'Kivo fee: 0.5%'}</Text></View></View>
 <View style={s.asset}><View style={s.top}><Text style={s.muted}>FROM</Text><Text style={s.muted}>Available: {from?`${formatAmount(from.spendableAmount)} ${from.symbol}`:balance?'—':'…'}</Text></View><View style={s.main}><Pressable style={s.selector} onPress={()=>setPicker('from')}>{from?<NetworkIcon chainKey={from.chain} size={26} />:null}<Text style={s.symbol}>{from?.symbol??'Select'}</Text><Text style={s.chev}>⌄</Text></Pressable><TextInput value={amount} onChangeText={v=>setAmount(normalizeAmountInput(v))} placeholder='0' placeholderTextColor={kivoTheme.colors.textMuted} keyboardType='decimal-pad' style={s.amount}/></View><View style={s.bottom}><Text style={s.muted}>{from?chainLabel(from.chain):''}{from&&n>0&&from.priceUsd>0?`  ·  ≈ ${formatUsd(n*from.priceUsd)}`:''}</Text>{from?<Pressable onPress={()=>setAmount(maxAmount(from.spendableAmount,from.decimals))}><Text style={s.max}>Max</Text></Pressable>:null}</View></View>
 <View style={s.swapWrap}><Pressable style={s.swap} onPress={()=>{if(!from||!to)return;setFromId(to.id);setToId(from.id);setAmount('');setQuote(null);setError(null);}}><Text style={s.swapText}>⇅</Text></Pressable></View>
 <View style={s.asset}><View style={s.top}><Text style={s.muted}>TO</Text><Text style={s.muted}>{to&&to.valueUsd>0?`Holding: ${formatUsd(to.valueUsd)}`:''}</Text></View><View style={s.main}><Pressable style={s.selector} onPress={()=>setPicker('to')}>{to?<NetworkIcon chainKey={to.chain} size={26} />:null}<Text style={s.symbol}>{to?.symbol??'Select'}</Text><Text style={s.chev}>⌄</Text></Pressable>{loading?<ActivityIndicator color={kivoTheme.colors.textMuted}/>:<Text style={s.receive} numberOfLines={1} adjustsFontSizeToFit>{quote?.receivedAmountFormatted?formatAmount(Number(quote.receivedAmountFormatted)):'0'}</Text>}</View><Text style={s.muted}>{to?chainLabel(to.chain):''}{quote?.receiveAmountUsd?`  ·  ≈ ${formatUsd(quote.receiveAmountUsd)}`:''}</Text></View>
 {error&&<Text style={s.error}>{error}</Text>}
 {hashes&&hashes.length>0&&error&&<View style={s.success}><Text style={s.successText}>Some transactions were already sent. Check them before trying again:</Text>{txLinks(hashes)}</View>}
 {hashes&&!error&&<View style={s.success}><Text style={s.successText}>{convertOutcomeLabel(nearRecord,relayStatus)}</Text>{sent&&<Text style={s.sentText}>Sent {sent.paid}{sent.received?`  →  received ${sent.received}`:''}</Text>}{txLinks(hashes)}</View>}
 <Pressable disabled={!quote||buttonLabel!=='Convert'} onPress={convert} style={[s.button,(!quote||buttonLabel!=='Convert')&&s.disabled]}><Text style={s.buttonText}>{buttonLabel}</Text></Pressable><Pressable onPress={onClose} style={s.cancel}><Text style={s.cancelText}>{hashes&&!error?'Done':'Cancel'}</Text></Pressable></>}</View></BottomSheet>;
}
const c={background:kivoTheme.colors.background,backgroundDeep:kivoTheme.colors.backgroundDeep,surface:kivoTheme.colors.surface,surfaceRaised:kivoTheme.colors.surfaceRaised,border:kivoTheme.colors.border,text:kivoTheme.colors.text,textMuted:kivoTheme.colors.textMuted,accent:kivoTheme.colors.accent,success:kivoTheme.colors.success,danger:kivoTheme.colors.danger,cream:kivoTheme.colors.cream}; const s=StyleSheet.create({
overlay:{...StyleSheet.absoluteFill,zIndex:100,justifyContent:'flex-end'},dismiss:{...StyleSheet.absoluteFill,backgroundColor:'rgba(0,0,0,.72)'},sheet:{backgroundColor:c.surface,borderTopLeftRadius:26,borderTopRightRadius:26,padding:20,paddingBottom:34,maxHeight:'90%',borderWidth:1,borderColor:c.border},handle:{width:48,height:5,borderRadius:3,backgroundColor:c.border,alignSelf:'center',marginBottom:14},
header:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',marginBottom:16},title:{color:c.text,fontSize:20,fontWeight:'900'},back:{color:c.textMuted,fontWeight:'700'},free:{backgroundColor:c.surfaceRaised,borderRadius:999,paddingHorizontal:10,paddingVertical:6},freeText:{color:c.success,fontSize:11,fontWeight:'800'},
asset:{backgroundColor:c.surfaceRaised,borderRadius:16,padding:14,gap:8},top:{flexDirection:'row',justifyContent:'space-between'},muted:{color:c.textMuted,fontSize:11,fontWeight:'700'},main:{flexDirection:'row',alignItems:'center',justifyContent:'space-between'},selector:{flexDirection:'row',alignItems:'center',gap:6},symbol:{color:c.text,fontSize:16,fontWeight:'900'},chev:{color:c.textMuted},amount:{flex:1,textAlign:'right',color:c.text,fontSize:25,fontWeight:'800',padding:0,marginLeft:12},receive:{color:c.text,fontSize:24,fontWeight:'800',maxWidth:'55%',textAlign:'right'},bottom:{flexDirection:'row',justifyContent:'space-between'},max:{color:c.cream,fontWeight:'900'},
swapWrap:{alignItems:'center',marginVertical:-12,zIndex:2},swap:{width:34,height:34,borderRadius:17,backgroundColor:c.surface,borderWidth:1,borderColor:c.border,alignItems:'center',justifyContent:'center'},swapText:{color:c.text,fontSize:17},error:{color:c.danger,fontSize:12,lineHeight:18,marginTop:10},success:{marginTop:10,gap:3},successText:{color:c.success,fontWeight:'800'},hash:{color:c.textMuted,fontSize:10},hashLink:{color:c.accent,textDecorationLine:'underline'},button:{height:52,borderRadius:26,backgroundColor:c.accent,alignItems:'center',justifyContent:'center',marginTop:16},buttonText:{color:c.backgroundDeep,fontWeight:'900',fontSize:15},disabled:{opacity:.45},list:{maxHeight:500},network:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',backgroundColor:c.surfaceRaised,borderRadius:15,padding:13,marginBottom:8,borderWidth:1,borderColor:'transparent'},networkSelected:{borderColor:c.accent},left:{flexDirection:'row',alignItems:'center',gap:10,flex:1},networkText:{color:c.text,fontWeight:'800'},networkBalance:{color:c.textMuted,fontWeight:'700',fontSize:12},networkSub:{color:c.textMuted,fontSize:10,marginTop:2},right:{alignItems:'flex-end'},sentText:{color:c.text,fontSize:12,fontWeight:'700'},cancel:{height:44,alignItems:'center',justifyContent:'center'},cancelText:{color:c.cream,fontWeight:'800'}
});

/** What the finished/pending conversion really is — "successfully" only once delivery is confirmed. */
/**
 * Max as a short decimal that never exceeds the spendable amount. Float maths
 * on 18-decimal USDC (BNB Chain) produced '0.92926483349762790…', a hair
 * above the balance, so Max showed 'Insufficient balance'. Amounts are shown
 * to 6 places, so round down there.
 */
function maxAmount(balance:number,decimals:number):string{
  if(!(balance>0))return '';
  const places=Math.min(6,decimals);
  const scale=10**places;
  return (Math.floor(balance*scale)/scale).toFixed(places).replace(/\.?0+$/,'');
}

function convertOutcomeLabel(nearRecord:OneClickSwapRecord|null,relayStatus:'success'|'pending'|'refunded'|null):string{
  if(nearRecord){
    if(nearRecord.status==='SUCCESS')return 'Converted successfully';
    if(nearRecord.status==='REFUNDED')return 'Not completed — the funds were refunded';
    if(nearRecord.status==='FAILED'||nearRecord.status==='SEND_FAILED')return 'Not completed';
    return 'Sent — waiting for NEAR Intents to deliver';
  }
  if(relayStatus==='pending')return 'Submitted — still settling';
  if(relayStatus==='refunded')return 'Not completed — the funds were refunded';
  return 'Converted successfully';
}
