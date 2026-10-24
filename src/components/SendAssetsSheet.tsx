import React, {useEffect, useRef, useState} from 'react';
import {ActivityIndicator, Image, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {encodeFunctionData, formatUnits, parseUnits} from 'viem';
import {Connection, PublicKey, SystemProgram} from '@solana/web3.js';
import {TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, calculateEpochFee, createAssociatedTokenAccountInstruction, createTransferCheckedInstruction, getAccountLenForMint, getAssociatedTokenAddress, getMint, getTransferFeeConfig} from '@solana/spl-token';
import {getViemChain} from '@kivo/trading/core/chainRegistry';
import {sendTransferCalls} from '@kivo/trading/kivo/cash';
import {SOLANA_NATIVE_SPEND} from '@kivo/trading/core/solanaSpendGuard';
import {signAndSendSponsoredSolanaStep, sponsorRepaymentUsdcUnits, type SolanaTransactionSigner} from '@kivo/trading/core/executeRelayQuote';
import {CLASSIC_TOKEN_ACCOUNT_SPACE, rentExemptLamports} from '@kivo/trading/core/solanaAccountCreation';
import {classifyTransferError} from '@kivo/trading/core/broadcastState';
import {CHAIN_LABEL, MAINNET_CHAIN_IDS, NATIVE_SYMBOL, TOKEN_ADDRESSES, type ChainKey} from '@kivo/trading/core/chainData';
import {fetchPortfolio, type Holding} from '@kivo/trading/kivo/portfolio';
import {getTradeHistory, recordTransfer, updateTransferStatus} from '@kivo/trading/kivo/history';
import {readTokenBalance, readTokenDecimals} from '@kivo/trading/kivo/balances';
import {relayRequestUrl, transactionLink} from '@kivo/trading/kivo/execute';
import {checkTransferStatus} from '@kivo/trading/kivo/transferStatus';
import {SOLANA_MAX_RESERVE_LAMPORTS, TOKEN_PROGRAM_OWNERS, blockedDestinationReason, chainMismatchReason, checkRecipientAddress, evmSponsorReason, fractionOf} from '@kivo/trading/kivo/transferGuards';
import {TokenIcon} from './TokenIcon';
import {kivoTheme} from '../theme/kivoTheme';
import {getWalletSession, withDeviceAccounts} from '../state/walletStore';
import {ResultCard} from './ResultCard';

const SOLANA_RPC_URL = 'https://rpc.solanatracker.io/public';
const SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const ABI = [{type:'function',name:'transfer',stateMutability:'nonpayable',inputs:[{name:'to',type:'address'},{name:'amount',type:'uint256'}],outputs:[{name:'',type:'bool'}]}] as const;
const ZERO = '0x0000000000000000000000000000000000000000';
/** Send by wallet address only. `initialRecipient` optionally prefills the address field. */
type Props = {visible:boolean; initialRecipient?:string; onClose:()=>void};
type Target = {family:'evm'|'solana'; address:string};
type Reviewed = {key:string; chainKey:string; address:string; kind:Holding['kind']; symbol:string; value:string; raw:bigint; decimals:number; to:string; programId?:string; feeRaw:bigint; accountLen?:number};
type TransferResult = {tone:'success'|'pending'|'error'; message:string; amount:string; symbol:string; recipient:string; network:string; hash?:string; requestId?:string; chainId?:number|null; transferId?:string; safe?:{text:string; ok:boolean}; canRetry:boolean};
const fmt = (n:number) => new Intl.NumberFormat(undefined,{maximumFractionDigits:n>=100?4:n>=1?6:9}).format(n);
const short = (a:string) => a.length > 16 ? a.slice(0,6)+'…'+a.slice(-5) : a;
const networkOf = (chainKey:string) => chainKey==='solana' ? 'Solana' : CHAIN_LABEL[chainKey as ChainKey]||chainKey;
function defaults():Holding[]{
 const rows:Holding[]=[];
 Object.keys(MAINNET_CHAIN_IDS).forEach(key=>{
  const chain=key as ChainKey; if(chain==='solana')return; const symbol=NATIVE_SYMBOL[chain]||'ETH';
  rows.push({key:chain+':native',kind:'native',chainKey:chain,address:ZERO,symbol,name:symbol+' · '+(CHAIN_LABEL[chain]||chain),amount:0,priceUsd:null,valueUsd:0,imageUrl:null});
  const usdc=TOKEN_ADDRESSES.USDC?.[chain];
  if(usdc)rows.push({key:chain+':'+usdc.toLowerCase(),kind:'cash',chainKey:chain,address:usdc,symbol:'USDC',name:'USD Coin · '+(CHAIN_LABEL[chain]||chain),amount:0,priceUsd:1,valueUsd:0,imageUrl:null});
 });
 rows.push({key:'solana:'+WSOL_MINT,kind:'native',chainKey:'solana' as ChainKey,address:WSOL_MINT,symbol:'SOL',name:'Solana',amount:0,priceUsd:null,valueUsd:0,imageUrl:null});
 rows.push({key:'solana:'+SOLANA_USDC_MINT,kind:'cash',chainKey:'solana' as ChainKey,address:SOLANA_USDC_MINT,symbol:'USDC',name:'USD Coin · Solana',amount:0,priceUsd:1,valueUsd:0,imageUrl:null});
 return rows;
}
async function solanaMintInfo(connection:Connection,mintAddress:string){
 const mint=new PublicKey(mintAddress);
 const account=await connection.getAccountInfo(mint,'confirmed');
 if(!account)throw new Error('That token mint was not found on Solana. Nothing was sent.');
 const owner=account.owner.toBase58();
 if(!TOKEN_PROGRAM_OWNERS.has(owner))throw new Error('This token is not an SPL token, so Kivo cannot send it. Nothing was sent.');
 const programId=owner===TOKEN_2022_PROGRAM_ID.toBase58()?TOKEN_2022_PROGRAM_ID:TOKEN_PROGRAM_ID;
 const info=await getMint(connection,mint,'confirmed',programId);
 return {programId,decimals:info.decimals,feeConfig:getTransferFeeConfig(info),accountLen:getAccountLenForMint(info)};
}
export function SendAssetsSheet({visible,initialRecipient='',onClose}:Props){
 const [transferResult,setTransferResult]=useState<TransferResult|null>(null);
 const [recipient,setRecipient]=useState(initialRecipient),[target,setTarget]=useState<Target|null>(null),[assets,setAssets]=useState<Holding[]>(defaults()),[selectedKey,setSelectedKey]=useState(''),[amount,setAmount]=useState(''),[loading,setLoading]=useState(false),[sending,setSending]=useState(false),[error,setError]=useState(''),[menuOpen,setMenuOpen]=useState(false),[step,setStep]=useState<'recipient'|'transfer'|'review'>('recipient'),[reviewed,setReviewed]=useState<Reviewed|null>(null),[checking,setChecking]=useState(false);
 // A synchronous lock: two taps in the same frame both see `sending === false`.
 const busy=useRef(false);
 const wallet=getWalletSession();
 const addressCheck=checkRecipientAddress(recipient);
 const reasonFor=(item:Holding)=>(target?chainMismatchReason(item.chainKey,target.family):null)??evmSponsorReason(item);
 const usable=assets.filter(item=>!reasonFor(item));
 const selected=usable.find(x=>x.key===selectedKey)||usable.find(x=>x.amount>0)||usable[0]||null;
 useEffect(()=>{if(visible){setTransferResult(null);setRecipient(initialRecipient);setAmount('');setError('');setMenuOpen(false);setReviewed(null);const check=checkRecipientAddress(initialRecipient);if(check.ok){setTarget({family:check.family,address:check.address});setStep('transfer');}else{setTarget(null);setStep('recipient');}}},[visible,initialRecipient]);
 useEffect(()=>{
  if(!visible)return;let active=true;setLoading(true);
  const w=getWalletSession();
  if(!w){setAssets(defaults());setLoading(false);return()=>{active=false;};}
  fetchPortfolio(w.address,getTradeHistory(),{solanaAddress:w.solanaAddress}).then(p=>{
   if(!active)return;const real=p.holdings.filter(x=>x.amount>0&&x.chainKey!=='near');const base=defaults();
   const merged=real.concat(base.filter(x=>!real.some(y=>y.key.toLowerCase()===x.key.toLowerCase())));
   setAssets(merged);
  }).catch(e=>{if(active)setError(e instanceof Error?e.message:'Could not read balances; standard assets remain listed.');}).finally(()=>{if(active)setLoading(false);});
  return()=>{active=false;};
 },[visible,wallet?.address,wallet?.solanaAddress]);
 // Any change after review means review again: only the reviewed transfer is ever signed.
 useEffect(()=>{setReviewed(null);if(step==='review')setStep('transfer');},[selected?.key,amount,target?.address]);// eslint-disable-line react-hooks/exhaustive-deps

 async function setQuickAmount(numerator:number){
  const item=selected;const w=getWalletSession();if(!item||!w)return;
  try{
   let raw:bigint,decimals:number;
   if(item.chainKey==='solana'){
    if(!w.solanaAddress)throw new Error('No Solana wallet.');
    const connection=new Connection(SOLANA_RPC_URL,'confirmed');const owner=new PublicKey(w.solanaAddress);
    if(item.kind==='native'){const lamports=BigInt(await connection.getBalance(owner,'confirmed'))-SOLANA_MAX_RESERVE_LAMPORTS;raw=lamports>0n?lamports:0n;decimals=9;}
    else{const mint=await solanaMintInfo(connection,item.address);const ata=await getAssociatedTokenAddress(new PublicKey(item.address),owner,false,mint.programId);const balance=await connection.getTokenAccountBalance(ata,'confirmed');raw=BigInt(balance.value.amount);decimals=balance.value.decimals;}
   }else{const balance=await readTokenBalance(item.chainKey as ChainKey,item.address,w.address);raw=balance.raw;decimals=balance.decimals;}
   setAmount(formatUnits(fractionOf(raw,numerator),decimals));
  }catch{
   // Exact balance unavailable: fall back to the listed balance, rounded down.
   const value=Math.floor(item.amount*numerator/100*1e6)/1e6;setAmount(value>0?String(value):'0');
  }
 }

 async function prepareReview(){
  const item=selected;const value=amount.trim();
  if(!target){setStep('recipient');setError('Paste a recipient wallet address first.');return;}
  if(!item){setError('None of your assets can be sent to this address.');return;}
  if(!wallet){setError('Unlock or import your Kivo wallet before sending.');return;}
  if(!value||!/^(?:\d+\.?\d*|\.\d+)$/.test(value)||!Number.isFinite(Number(value))||Number(value)<=0){setError('Enter an amount greater than zero.');return;}
  if(item.amount<=0||Number(value)>item.amount){setError('Insufficient '+item.symbol+' balance. Available: '+fmt(item.amount)+'.');return;}
  const mismatch=chainMismatchReason(item.chainKey,target.family);if(mismatch){setError(mismatch+'.');return;}
  const sponsor=evmSponsorReason(item,Number(value));if(sponsor){setError(sponsor+'.');return;}
  const blocked=blockedDestinationReason({to:target.address,family:target.family,ownAddresses:[wallet.address,wallet.solanaAddress],tokenAddress:item.kind==='native'?null:item.address});
  if(blocked){setError(blocked);return;}
  setSending(true);
  try{
   let decimals=18,programId:string|undefined,feeRaw=0n,accountLen:number|undefined;let mintInfo:Awaited<ReturnType<typeof solanaMintInfo>>|null=null;
   if(item.chainKey==='solana'){
    const connection=new Connection(SOLANA_RPC_URL,'confirmed');
    const destination=await connection.getAccountInfo(new PublicKey(target.address),'confirmed');
    if(destination&&TOKEN_PROGRAM_OWNERS.has(destination.owner.toBase58()))throw new Error('That address is a token account or mint, not a wallet. Ask the recipient for their wallet address.');
    if(item.kind==='native')decimals=9;
    else{mintInfo=await solanaMintInfo(connection,item.address);decimals=mintInfo.decimals;programId=mintInfo.programId.toBase58();accountLen=mintInfo.accountLen;}
   }else if(item.kind!=='native')decimals=await readTokenDecimals(item.chainKey as ChainKey,item.address);
   let raw:bigint;try{raw=parseUnits(value,decimals);}catch{throw new Error(item.symbol+' supports at most '+decimals+' decimal places.');}
   if(mintInfo?.feeConfig){const epoch=await new Connection(SOLANA_RPC_URL,'confirmed').getEpochInfo('confirmed');feeRaw=calculateEpochFee(mintInfo.feeConfig,BigInt(epoch.epoch),raw);}
   setReviewed({key:item.key,chainKey:item.chainKey,address:item.address,kind:item.kind,symbol:item.symbol,value,raw,decimals,to:target.address,programId,feeRaw,accountLen});
   setStep('review');
  }catch(e){setError(e instanceof Error?e.message:'Could not prepare this transfer. Nothing was sent.');}
  finally{setSending(false);}
 }

 async function confirmAndSend(){
  if(busy.current)return;
  const snapshot=reviewed;const item=selected;
  if(!snapshot||!item||!target||snapshot.key!==item.key||snapshot.address!==item.address||snapshot.value!==amount.trim()||snapshot.to!==target.address){
   setReviewed(null);setStep('transfer');setError('The asset, amount or address changed after review. Review the transfer again. Nothing was sent.');return;
  }
  busy.current=true;setSending(true);setError('');
  const network=networkOf(snapshot.chainKey);
  const chainId=snapshot.chainKey==='solana'?null:MAINNET_CHAIN_IDS[snapshot.chainKey as ChainKey]??null;
  const base={amount:snapshot.value,symbol:snapshot.symbol,recipient:short(snapshot.to),network,chainId};
  const record=(status:'success'|'pending',hash?:string,requestId?:string,error?:string)=>recordTransfer({kind:'send',chainKey:snapshot.chainKey,chainId,symbol:snapshot.symbol,amount:snapshot.value,to:snapshot.to,txHash:hash??null,requestId:requestId??null,status,error})?.id;
  try{
   if(snapshot.chainKey==='solana'){
    const connection=new Connection(SOLANA_RPC_URL,'confirmed');
    const signature=await withDeviceAccounts('Confirm asset transfer',async({solana})=>{
     if(!solana)throw new Error('This wallet has no Solana signing key. Nothing was sent.');
     const destination=new PublicKey(snapshot.to),owner=solana.publicKey;
     const instructions=[];
     let spendIntent:{spend:string;maxSpend:bigint};
     if(snapshot.kind==='native'){
      instructions.push(SystemProgram.transfer({fromPubkey:owner,toPubkey:destination,lamports:snapshot.raw}));
      spendIntent={spend:SOLANA_NATIVE_SPEND,maxSpend:snapshot.raw};
     }else{
      const mint=new PublicKey(snapshot.address),programId=new PublicKey(snapshot.programId??TOKEN_PROGRAM_ID.toBase58());
      const source=await getAssociatedTokenAddress(mint,owner,false,programId),ata=await getAssociatedTokenAddress(mint,destination,false,programId);
      if(!(await connection.getAccountInfo(ata,'confirmed'))){
       instructions.push(createAssociatedTokenAccountInstruction(owner,ata,destination,mint,programId));
       // Kivo fronts the recipient's one-time token-account rent and this wallet repays it in the
       // same transaction (USDC first, else SOL). Sending all of its USDC would leave nothing to repay with.
       if(snapshot.address===TOKEN_ADDRESSES.USDC?.solana){
        const rent=rentExemptLamports(CLASSIC_TOKEN_ACCOUNT_SPACE);
        const [repay,held,lamports]=await Promise.all([sponsorRepaymentUsdcUnits(rent),connection.getTokenAccountBalance(source,'confirmed').then(r=>BigInt(r.value.amount)).catch(()=>null),connection.getBalance(owner,'confirmed').catch(()=>0)]);
        if(held!==null&&repay>0n&&held<snapshot.raw+repay&&lamports<rent+10_000){
         const most=held>repay?Number(held-repay)/10**snapshot.decimals:0;
         throw new Error('This recipient needs a one-time USDC account (about '+(Number(repay)/1e6).toFixed(2)+' USDC, repaid to Kivo in this transaction). Send at most '+most.toFixed(2)+' USDC. Nothing was sent.');
        }
       }
      }
      instructions.push(createTransferCheckedInstruction(source,mint,ata,owner,snapshot.raw,snapshot.decimals,[],programId));
      spendIntent={spend:snapshot.address,maxSpend:snapshot.raw};
     }
     const signer:SolanaTransactionSigner={publicKey:owner,async sign(transaction){transaction.sign([solana]);return transaction;}};
     // Returns once the transaction is confirmed on-chain.
     const sponsored=await signAndSendSponsoredSolanaStep(instructions,[],signer,connection,spendIntent,{allowedAtaOwners:[destination.toBase58()]});
     return sponsored.signature;
    });
    setTransferResult({...base,tone:'success',message:'Your transfer is confirmed on Solana.',hash:signature,transferId:record('success',signature),canRetry:false});
   }else{
    const call={to:snapshot.address as `0x${string}`,value:0n,data:encodeFunctionData({abi:ABI,functionName:'transfer',args:[snapshot.to as `0x${string}`,snapshot.raw]})};
    const result=await withDeviceAccounts('Confirm asset transfer',async({evm})=>
     // Ethereum mainnet: Kivo never sponsors transfers there, so the wallet's own ETH pays the gas (checked first).
     sendTransferCalls({chain:getViemChain(snapshot.chainKey as ChainKey),chainKey:snapshot.chainKey as ChainKey,account:evm,calls:[call]}));
    // Relay reported success: the transfer is on-chain.
    setTransferResult({...base,tone:'success',message:'Your transfer is confirmed on '+network+'.',hash:result.hash,requestId:result.requestId,transferId:record('success',result.hash,result.requestId),canRetry:false});
   }
  }catch(e){
   const classified=classifyTransferError(e);
   if(classified.state==='maybe-sent'){
    const hash=classified.txHashes[classified.txHashes.length-1]??classified.signature;
    setTransferResult({...base,tone:'pending',message:classified.message,hash,requestId:classified.requestId,transferId:record('pending',hash,classified.requestId,classified.message),safe:{ok:false,text:'This transfer may already be on-chain. Do not send it again: check its status first.'},canRetry:false});
   }else if(classified.state==='failed-on-chain'){
    setTransferResult({...base,tone:'error',message:classified.message,hash:classified.signature,requestId:classified.requestId,safe:{ok:true,text:'The transaction failed on-chain, so your tokens did not move.'},canRetry:true});
   }else{
    const message=/nothing was sent/i.test(classified.message)?classified.message:classified.message+' Nothing was sent.';
    setTransferResult({...base,tone:'error',message,safe:{ok:true,text:'Nothing was sent. Your balance is unchanged.'},canRetry:true});
    setError(message);
   }
  }finally{busy.current=false;setSending(false);}
 }

 async function recheck(){
  const current=transferResult;if(!current||checking)return;
  setChecking(true);
  try{
   const status=await checkTransferStatus({txHash:current.hash,requestId:current.requestId,chainId:current.chainId});
   if(status==='pending')return;
   if(current.transferId)updateTransferStatus(current.transferId,status==='confirmed'?'success':'failed');
   setTransferResult({...current,tone:status==='confirmed'?'success':'error',message:status==='confirmed'?'Your transfer is confirmed.':'The transaction did not complete on-chain, so your tokens did not move.',safe:status==='confirmed'?undefined:{ok:true,text:'Your tokens did not move.'},canRetry:status!=='confirmed'});
  }finally{setChecking(false);}
 }

 async function submit(){
  if(sending||busy.current)return;setError('');
  if(step==='recipient'){if(!addressCheck.ok){setError(addressCheck.problem??'Paste a wallet address.');return;}setTarget({family:addressCheck.family,address:addressCheck.address});setStep('transfer');return;}
  if(step==='transfer'){await prepareReview();return;}
  await confirmAndSend();
 }
 const list=[...usable,...assets.filter(item=>reasonFor(item))].filter(x=>x.amount>0||x.kind==='native'||x.symbol==='USDC');
 const familyNote=target?.family==='solana'?'Solana address: only Solana assets can be sent to it.':target?.family==='evm'?'EVM address: only USDC on EVM networks can be sent (Kivo covers the gas).':'';
 const links=transferResult?[
  ...(transferResult.hash?[{label:transferResult.network==='Solana'?'View on Solscan':'View on explorer',url:transactionLink(transferResult.hash,transferResult.chainId)}]:[]),
  ...(transferResult.requestId?[{label:'Route status',url:relayRequestUrl(transferResult.requestId)}]:[]),
 ]:[];
 return <><Modal visible={visible&&!transferResult} animationType="slide" transparent onRequestClose={onClose}>
  <KeyboardAvoidingView style={styles.overlay} behavior={Platform.OS==='ios'?'padding':undefined}>
   <View style={styles.sheet}>
    <View style={styles.header}><Text style={styles.title}>Send assets</Text><Pressable onPress={onClose}><Text style={styles.close}>×</Text></Pressable></View>
    <Text style={styles.muted}>Paste a wallet address. Review the full address before signing.</Text>
    {step==='recipient'?<><Text style={styles.label}>Recipient wallet address</Text>
    <TextInput value={recipient} onChangeText={v=>{setRecipient(v);setTarget(null);}} autoCapitalize="none" autoCorrect={false} placeholder="0x… or Solana wallet address" placeholderTextColor={kivoTheme.colors.textMuted} style={styles.input} accessibilityLabel="Recipient wallet address"/>
    {addressCheck.ok?<Text style={styles.muted}>{addressCheck.family==='solana'?'Solana wallet address. Only Solana assets can be sent to it.':'EVM wallet address. Only EVM-network assets can be sent to it.'}</Text>:addressCheck.problem?<Text style={styles.error}>{addressCheck.problem}</Text>:null}</>:null}
    {step==='transfer'&&target?<><View style={styles.recipientSummary}><Text style={styles.muted}>SENDING TO</Text><Text style={styles.assetTitle} selectable>{target.address}</Text></View>
    <Text style={styles.label}>Asset</Text>
    <Pressable style={styles.asset} onPress={()=>setMenuOpen(x=>!x)}>{selected?<><TokenIcon kind={selected.kind} symbol={selected.symbol} chainKey={selected.chainKey as ChainKey} address={selected.address} imageUrl={selected.imageUrl} size={36}/><View style={styles.copy}><Text style={styles.assetTitle}>{selected.symbol}</Text><Text style={styles.muted}>{selected.name} · Available {fmt(selected.amount)}</Text></View></>:<View style={styles.copy}><Text style={styles.assetTitle}>No asset can go to this address</Text><Text style={styles.muted}>{familyNote}</Text></View>}<Text style={styles.muted}>{menuOpen?'⌃':'⌄'}</Text></Pressable>
    {menuOpen?<ScrollView style={styles.menu} nestedScrollEnabled>{list.map(item=>{const reason=reasonFor(item);return <Pressable key={item.key} disabled={Boolean(reason)} onPress={()=>{setSelectedKey(item.key);setMenuOpen(false);}} style={[styles.option,item.key===selected?.key&&styles.active,reason?{opacity:0.45}:null]}><TokenIcon kind={item.kind} symbol={item.symbol} chainKey={item.chainKey as ChainKey} address={item.address} imageUrl={item.imageUrl} size={32}/><View style={styles.copy}><Text style={styles.assetTitle}>{item.symbol}</Text><Text style={styles.muted}>{reason??item.name}</Text></View><Text style={styles.balance}>{fmt(item.amount)}</Text></Pressable>;})}</ScrollView>:null}
    <Text style={styles.label}>Amount</Text><TextInput value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor={kivoTheme.colors.textMuted} style={styles.input}/>
    <View style={styles.quickAmounts}>{[['10%',10],['25%',25],['50%',50],['Max',100]].map(([label,numerator])=><Pressable key={String(label)} style={styles.quickAmount} onPress={()=>void setQuickAmount(Number(numerator))}><Text style={styles.quickAmountText}>{String(label)}</Text></Pressable>)}</View>
    {loading?<ActivityIndicator color={kivoTheme.colors.accent}/>:null}
    <Text style={styles.muted}>{familyNote}</Text>
    </>:null}
    {step==='review'&&reviewed?<><Text style={styles.reviewTitle}>Review transfer</Text><View style={styles.reviewCard}>
     <View style={styles.reviewAddress}><Text style={styles.muted}>Recipient address</Text><Text style={styles.reviewAddressText} selectable>{reviewed.to}</Text></View>
     <View style={styles.reviewRow}><Text style={styles.muted}>Asset / network</Text><Text style={styles.reviewValue}>{reviewed.symbol+' · '+networkOf(reviewed.chainKey)}</Text></View>
     <View style={styles.reviewRow}><Text style={styles.muted}>Amount</Text><Text style={styles.reviewValue}>{reviewed.value+' '+reviewed.symbol}</Text></View>
     {reviewed.feeRaw>0n?<><View style={styles.reviewRow}><Text style={styles.muted}>Token transfer fee</Text><Text style={styles.reviewValue}>{formatUnits(reviewed.feeRaw,reviewed.decimals)+' '+reviewed.symbol}</Text></View><View style={styles.reviewRow}><Text style={styles.muted}>Recipient receives</Text><Text style={styles.reviewValue}>{'≈ '+formatUnits(reviewed.raw-reviewed.feeRaw,reviewed.decimals)+' '+reviewed.symbol}</Text></View></>:null}
     <Text style={styles.muted}>Kivo covers the network fee. Check every character of the address: transfers can't be reversed.</Text></View></>:null}
    {error?<Text style={styles.error}>{error}</Text>:null}
    {step!=='recipient'?<Pressable disabled={sending} onPress={()=>{setError('');if(step==='review'){setReviewed(null);setStep('transfer');}else setStep('recipient');}} style={styles.back}><Text style={styles.backText}>{step==='review'?'Back to amount':'Change address'}</Text></Pressable>:null}
    {(()=>{const disabled=loading||sending||(step==='recipient'&&!addressCheck.ok)||(step==='transfer'&&!selected);return <Pressable disabled={disabled} onPress={()=>void submit()} style={[styles.send,disabled&&{opacity:0.65}]}><Text style={styles.sendText}>{sending?(step==='review'?'Sending…':'Checking…'):step==='recipient'?'Continue':step==='transfer'?'Review transfer':'Confirm and sign'}</Text></Pressable>;})()}
   </View>
  </KeyboardAvoidingView>
 </Modal>
 <Modal visible={visible&&Boolean(transferResult)} animationType="fade" transparent onRequestClose={()=>{setTransferResult(null);onClose();}}>
  <View style={styles.resultOverlay}>
   <View style={styles.resultSheet}>
    <View style={styles.resultBrand}><Image source={require('../assets/kivo-logo.png')} style={styles.resultBrandLogo} resizeMode="contain"/><Pressable onPress={()=>{setTransferResult(null);onClose();}} accessibilityRole="button" accessibilityLabel="Close transfer result"><Text style={styles.close}>×</Text></Pressable></View>
    {transferResult?<ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.resultScroll}>
     <ResultCard
      tone={transferResult.tone}
      kicker={transferResult.tone==='success'?'Transfer complete':transferResult.tone==='pending'?'Transfer pending':'Transfer did not go through'}
      headline={transferResult.tone==='success'?'Transfer successful':transferResult.tone==='pending'?'Do not send again':"Couldn't complete this"}
      subline={transferResult.amount+' '+transferResult.symbol+' · '+transferResult.network}
      hero={{symbol:transferResult.symbol}}
      safeNote={transferResult.safe}
      reason={transferResult.tone!=='success'?transferResult.message:undefined}
      rows={[{label:'Recipient',value:transferResult.recipient},{label:'Network',value:transferResult.network},{label:'Status',value:transferResult.tone==='success'?'Confirmed':transferResult.tone==='pending'?'Pending · check before retrying':'Not completed'},...(transferResult.hash?[{label:'Transaction',value:transferResult.hash.slice(0,8)+'…'+transferResult.hash.slice(-6)}]:[])]}
      links={links}
      primary={transferResult.tone==='pending'&&(transferResult.hash||transferResult.requestId)
       ?{label:checking?'Checking…':'Check status',onPress:()=>{void recheck();}}
       :transferResult.canRetry?{label:'Try again',onPress:()=>{setTransferResult(null);setError('');setReviewed(null);setStep('transfer');}}
       :{label:'Done',onPress:()=>{setTransferResult(null);onClose();}}}
      secondary={transferResult.tone==='success'?undefined:{label:'Close',onPress:()=>{setTransferResult(null);onClose();}}}
     />
    </ScrollView>:null}
   </View>
  </View>
 </Modal></>;
}
const styles=StyleSheet.create({
 suggestions:{maxHeight:190,borderRadius:14,borderWidth:1,borderColor:'rgba(183,226,123,0.25)',backgroundColor:'#0B1E17',overflow:'hidden'},suggestion:{minHeight:58,paddingHorizontal:10,paddingVertical:8,flexDirection:'row',alignItems:'center',gap:10,borderBottomWidth:StyleSheet.hairlineWidth,borderBottomColor:'rgba(183,226,123,0.15)'},suggestionAvatar:{width:42,height:42,borderRadius:21,overflow:'hidden',alignItems:'center',justifyContent:'center',backgroundColor:'#12372D',borderWidth:1,borderColor:'rgba(183,226,123,0.3)'},suggestionAvatarImage:{width:42,height:42,borderRadius:21},suggestionInitial:{color:kivoTheme.colors.accent,fontWeight:'800'},recipientSummary:{padding:12,borderRadius:13,borderWidth:1,borderColor:kivoTheme.colors.border,backgroundColor:'rgba(183,226,123,0.05)',gap:5},quickAmounts:{flexDirection:'row',gap:8},quickAmount:{flex:1,minHeight:38,borderRadius:10,backgroundColor:'#12372D',alignItems:'center',justifyContent:'center'},quickAmountText:{color:kivoTheme.colors.text,fontWeight:'700'},reviewTitle:{color:kivoTheme.colors.text,fontSize:19,fontWeight:'800'},reviewCard:{padding:14,borderRadius:14,borderWidth:1,borderColor:kivoTheme.colors.border,backgroundColor:'#062F2C',gap:10},reviewRow:{flexDirection:'row',justifyContent:'space-between',alignItems:'flex-start',gap:12,paddingBottom:10,borderBottomWidth:StyleSheet.hairlineWidth,borderBottomColor:kivoTheme.colors.border},reviewValue:{color:kivoTheme.colors.text,fontSize:13,fontWeight:'700',flexShrink:1,textAlign:'right'},reviewAddress:{gap:4,paddingBottom:10,borderBottomWidth:StyleSheet.hairlineWidth,borderBottomColor:kivoTheme.colors.border},reviewAddressText:{color:kivoTheme.colors.text,fontSize:13,fontWeight:'700',fontFamily:Platform.OS==='ios'?'Menlo':'monospace'},back:{minHeight:46,alignItems:'center',justifyContent:'center'},backText:{color:kivoTheme.colors.accent,fontWeight:'700'},
 resultOverlay:{flex:1,justifyContent:'center',padding:16,backgroundColor:'rgba(0,0,0,0.72)'},resultSheet:{maxHeight:'92%',padding:16,borderRadius:24,borderWidth:1,borderColor:'rgba(183,226,123,0.25)',backgroundColor:'#0B1E17'},resultBrand:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',marginBottom:8},resultBrandLogo:{width:76,height:28},resultScroll:{paddingBottom:4},overlay:{flex:1,justifyContent:'flex-end',backgroundColor:'rgba(0,0,0,0.62)'},
 sheet:{backgroundColor:'#0B1E17',borderColor:'rgba(183,226,123,0.25)',borderWidth:1,borderTopLeftRadius:26,borderTopRightRadius:26,padding:20,gap:10,maxHeight:'94%'},
 header:{flexDirection:'row',alignItems:'center',justifyContent:'space-between'},title:{color:kivoTheme.colors.text,fontSize:22,fontWeight:'800'},close:{color:kivoTheme.colors.text,fontSize:32,lineHeight:34},
 muted:{color:kivoTheme.colors.textMuted,fontSize:12},label:{color:kivoTheme.colors.text,fontSize:14,fontWeight:'700',marginTop:3},
 input:{minHeight:52,borderRadius:15,borderWidth:1,borderColor:kivoTheme.colors.border,backgroundColor:'#062F2C',paddingHorizontal:14,color:kivoTheme.colors.text,fontSize:15},
 asset:{minHeight:64,borderRadius:16,borderWidth:1,borderColor:kivoTheme.colors.accent,backgroundColor:'#062F2C',padding:10,flexDirection:'row',alignItems:'center',gap:10},copy:{flex:1,minWidth:0},assetTitle:{color:kivoTheme.colors.text,fontWeight:'800',fontSize:15},
 menu:{maxHeight:220,borderRadius:16,borderWidth:1,borderColor:'rgba(183,226,123,0.25)',backgroundColor:'#0B1E17',padding:6},option:{minHeight:56,borderRadius:12,padding:8,flexDirection:'row',alignItems:'center',gap:10},active:{backgroundColor:'#12372D'},balance:{color:kivoTheme.colors.text,fontSize:13},
 error:{color:kivoTheme.colors.danger,fontSize:13},send:{marginTop:8,minHeight:56,borderRadius:16,alignItems:'center',justifyContent:'center',backgroundColor:kivoTheme.colors.cream},sendText:{color:'#17372B',fontWeight:'800',fontSize:16}
});
