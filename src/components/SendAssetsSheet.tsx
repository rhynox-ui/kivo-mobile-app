import React, {useEffect, useState} from 'react';
import {ActivityIndicator, Alert, Image, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {encodeFunctionData, isAddress, parseUnits} from 'viem';
import {Connection, PublicKey, SystemProgram} from '@solana/web3.js';
import {createAssociatedTokenAccountInstruction, createTransferCheckedInstruction, getAssociatedTokenAddress} from '@solana/spl-token';
import {getViemChain} from '@kivo/trading/core/chainRegistry';
import {sendEvmCallsViaRelayGasless} from '@kivo/trading/core/relayGaslessEvm';
import {SOLANA_NATIVE_SPEND} from '@kivo/trading/core/solanaSpendGuard';
import {signAndSendSponsoredSolanaStep, type SolanaTransactionSigner} from '@kivo/trading/core/executeRelayQuote';
import {CHAIN_LABEL, MAINNET_CHAIN_IDS, NATIVE_SYMBOL, TOKEN_ADDRESSES, type ChainKey} from '@kivo/trading/core/chainData';
import {fetchPortfolio, type Holding} from '@kivo/trading/kivo/portfolio';
import {getTradeHistory} from '@kivo/trading/kivo/history';
import {readTokenDecimals} from '@kivo/trading/kivo/balances';
const SOLANA_RPC_URL = 'https://rpc.solanatracker.io/public';
const SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
import {TokenIcon} from './TokenIcon';
import {kivoTheme} from '../theme/kivoTheme';
import {api} from '../state/session';
import {getWalletSession, localEvmSigner, subscribeToWallet, withDeviceAccounts, type WalletSession} from '../state/walletStore';
import {walletAddressOfUserId} from '@kivo/shared/api/types';

const ABI = [{type:'function',name:'transfer',stateMutability:'nonpayable',inputs:[{name:'to',type:'address'},{name:'amount',type:'uint256'}],outputs:[{name:'',type:'bool'}]}] as const;
const ZERO = '0x0000000000000000000000000000000000000000';
type Props = {visible:boolean; initialRecipient?:string; initialRecipientName?:string; skipRecipientStep?:boolean; onClose:()=>void};
type ProfileSearchResults = Awaited<ReturnType<typeof api.searchProfiles>>;
const fmt = (n:number) => new Intl.NumberFormat(undefined,{maximumFractionDigits:n>=100?4:n>=1?6:9}).format(n);
function isSolanaAddress(v:string){try{return !v.startsWith('0x')&&new PublicKey(v).toBase58()===v;}catch{return false;}}
function defaults():Holding[]{
 const rows:Holding[]=[];
 Object.keys(MAINNET_CHAIN_IDS).forEach(key=>{
  const chain=key as ChainKey; const symbol=NATIVE_SYMBOL[chain]||'ETH';
  rows.push({key:chain+':native',kind:'native',chainKey:chain,address:ZERO,symbol,name:symbol+' · '+(CHAIN_LABEL[chain]||chain),amount:0,priceUsd:null,valueUsd:0,imageUrl:null});
  const usdc=TOKEN_ADDRESSES.USDC?.[chain];
  if(usdc)rows.push({key:chain+':'+usdc.toLowerCase(),kind:'cash',chainKey:chain,address:usdc,symbol:'USDC',name:'USD Coin · '+(CHAIN_LABEL[chain]||chain),amount:0,priceUsd:1,valueUsd:0,imageUrl:null});
 });
 rows.push({key:'solana:'+WSOL_MINT,kind:'native',chainKey:'solana' as ChainKey,address:WSOL_MINT,symbol:'SOL',name:'Solana',amount:0,priceUsd:null,valueUsd:0,imageUrl:null});
 rows.push({key:'solana:'+SOLANA_USDC_MINT,kind:'cash',chainKey:'solana' as ChainKey,address:SOLANA_USDC_MINT,symbol:'USDC',name:'USD Coin · Solana',amount:0,priceUsd:1,valueUsd:0,imageUrl:null});
 return rows;
}
export function SendAssetsSheet({visible,initialRecipient='',initialRecipientName='',skipRecipientStep=false,onClose}:Props){
 const [recipient,setRecipient]=useState(initialRecipient),[assets,setAssets]=useState<Holding[]>(defaults()),[selectedKey,setSelectedKey]=useState(''),[amount,setAmount]=useState(''),[loading,setLoading]=useState(false),[sending,setSending]=useState(false),[error,setError]=useState(''),[menuOpen,setMenuOpen]=useState(false),[matches,setMatches]=useState<ProfileSearchResults>([]),[searching,setSearching]=useState(false),[step,setStep]=useState<'recipient'|'transfer'|'review'>('recipient'),[resolvedAddress,setResolvedAddress]=useState(''),[resolvedUsername,setResolvedUsername]=useState('');
 const wallet=getWalletSession();
 const selected=assets.find(x=>x.key===selectedKey)||assets.find(x=>x.amount>0)||assets[0];
 useEffect(()=>{if(visible){setRecipient(initialRecipient);setAmount('');setError('');setMenuOpen(false);setMatches([]);setStep(skipRecipientStep&&initialRecipient?'transfer':'recipient');setResolvedAddress(skipRecipientStep?initialRecipient:'');setResolvedUsername(skipRecipientStep?initialRecipientName.replace(/^@/,''):'');}},[visible,initialRecipient,initialRecipientName,skipRecipientStep]);
 useEffect(()=>{
  if(!visible){setMatches([]);return;}
  const raw=recipient.trim();
  const username=raw.replace(/^@/,'').toLowerCase();
  if(!username||isSolanaAddress(raw)||isAddress(raw)||!/^[a-z0-9_]{1,32}$/.test(username)){setMatches([]);setSearching(false);return;}
  let active=true;
  const timer=setTimeout(()=>{
   setSearching(true);
   void api.searchProfiles(username).then(profiles=>{
    if(!active)return;
    setMatches(profiles.filter(profile=>profile.username?.toLowerCase().includes(username)).slice(0,6));
   }).catch(()=>{if(active)setMatches([]);}).finally(()=>{if(active)setSearching(false);});
  },220);
  return()=>{active=false;clearTimeout(timer);};
 },[visible,recipient]);
 useEffect(()=>{
  if(!visible)return;let active=true;setLoading(true);
  const w=getWalletSession();
  if(!w){setAssets(defaults());setSelectedKey('ethereum:native');setLoading(false);return()=>{active=false;};}
  fetchPortfolio(w.address,getTradeHistory(),{solanaAddress:w.solanaAddress}).then(p=>{
   if(!active)return;const real=p.holdings.filter(x=>x.amount>0&&x.chainKey!=='near');const base=defaults();
   const merged=real.concat(base.filter(x=>!real.some(y=>y.key.toLowerCase()===x.key.toLowerCase())));
   setAssets(merged);setSelectedKey(old=>merged.some(x=>x.key===old)?old:(merged.find(x=>x.amount>0)?.key||merged[0]?.key||''));
  }).catch(e=>{if(active)setError(e instanceof Error?e.message:'Could not read balances; standard assets remain listed.');}).finally(()=>{if(active)setLoading(false);});
  return()=>{active=false;};
 },[visible,wallet?.address,wallet?.solanaAddress]);
 async function resolve():Promise<string>{
  const value=recipient.trim();if(isAddress(value)||isSolanaAddress(value)){setResolvedUsername('');return value;}
  const username=value.replace(/^@/,'').toLowerCase();
  if(!/^[a-z0-9_]{3,32}$/.test(username))throw new Error('Enter a valid @username, EVM address, or Solana address.');
  const found=await api.searchProfiles(username);const p=found.find(x=>x.username?.toLowerCase()===username);
  const address=p?.address||(p?.userId?walletAddressOfUserId(p.userId):null);
  if(!address)throw new Error('No registered wallet found for @'+username+'.');
  setResolvedUsername(p?.username||username);return address;
 }
 async function submit(){
  if(sending)return;setError('');
  if(step==='recipient'){try{const to=await resolve();setResolvedAddress(to);setStep('transfer');}catch(e){setError(e instanceof Error?e.message:'Could not resolve recipient.');}return;}
  const value=amount.trim();
  if(!value||!/^(?:\d+\.?\d*|\.\d+)$/.test(value)||!Number.isFinite(Number(value))||Number(value)<=0){setError('Enter an amount greater than zero.');return;}
  if(!selected){setError('Choose an asset.');return;}
  if(step==='transfer'){if(!wallet){setError('Unlock or import your Kivo wallet before sending.');return;}if(selected.amount<=0||Number(value)>selected.amount){setError('Insufficient '+selected.symbol+' balance. Available: '+fmt(selected.amount)+'.');return;}setStep('review');return;}
  if(!wallet){setError('Unlock or import your Kivo wallet before sending.');setStep('transfer');return;}
  if(selected.amount<=0||Number(value)>selected.amount){setError('Insufficient '+selected.symbol+' balance. Available: '+fmt(selected.amount)+'.');setStep('transfer');return;}
  setSending(true);
  try{
   const to=resolvedAddress||await resolve();
   if(selected.chainKey==='solana'){
    if(!isSolanaAddress(to))throw new Error('This asset needs a Solana recipient address.');
    const connection=new Connection(SOLANA_RPC_URL,'confirmed');
    const signature=await withDeviceAccounts('Confirm asset transfer',async({solana})=>{
     if(!solana)throw new Error('This wallet has no Solana signing key. Nothing was sent.');
     const destination=new PublicKey(to),owner=solana.publicKey;
     const instructions=[];
     let spendIntent:{spend:string;maxSpend:bigint}|undefined;
     if(selected.kind==='native'){
      const rawAmount=parseUnits(value,9);
      instructions.push(SystemProgram.transfer({fromPubkey:owner,toPubkey:destination,lamports:rawAmount}));
      spendIntent={spend:SOLANA_NATIVE_SPEND,maxSpend:rawAmount};
     }else{
      const mint=new PublicKey(selected.address),decimals=(await connection.getTokenSupply(mint,'confirmed')).value.decimals;
      const rawAmount=parseUnits(value,decimals);
      const source=await getAssociatedTokenAddress(mint,owner),target=await getAssociatedTokenAddress(mint,destination);
      if(!(await connection.getAccountInfo(target,'confirmed')))instructions.push(createAssociatedTokenAccountInstruction(owner,target,destination,mint));
      instructions.push(createTransferCheckedInstruction(source,mint,target,owner,rawAmount,decimals));
      spendIntent={spend:selected.address,maxSpend:rawAmount};
     }
     const signer:SolanaTransactionSigner={publicKey:owner,async sign(transaction){transaction.sign([solana]);return transaction;}};
     const sponsored=await signAndSendSponsoredSolanaStep(instructions,[],signer,connection,spendIntent,{allowedAtaOwners:[destination.toBase58()]});
     return sponsored.signature;
    });
    Alert.alert('Transfer submitted','Solana transaction: '+signature.slice(0,12)+'…',[{text:'Done',onPress:onClose}]);
   }else{
    if(!isAddress(to))throw new Error('This EVM asset needs an EVM recipient address.');
    const chainId=MAINNET_CHAIN_IDS[selected.chainKey as ChainKey];if(!chainId)throw new Error('Unsupported transfer network.');
    const signer=await localEvmSigner();
    const call=selected.kind==='native'
     ? {to:to as `0x${string}`,value:parseUnits(value,18),data:'0x' as `0x${string}`}
     : {to:selected.address as `0x${string}`,value:0n,data:encodeFunctionData({abi:ABI,functionName:'transfer',args:[to as `0x${string}`,parseUnits(value,await readTokenDecimals(selected.chainKey as ChainKey,selected.address))]})};
    const result=await sendEvmCallsViaRelayGasless({chain:getViemChain(selected.chainKey as ChainKey),fromAddress:signer.address,account:signer,calls:[call]});
    Alert.alert('Transfer submitted','Transaction: '+result.hash.slice(0,12)+'… · Kivo sponsored gas with Relay.',[{text:'Done',onPress:onClose}]);
   }
  }catch(e){setError(e instanceof Error?e.message:'Transfer failed.');}finally{setSending(false);}
 }
 const list=assets.filter(x=>x.amount>0||x.kind==='native'||x.symbol==='USDC');
 return <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
  <KeyboardAvoidingView style={styles.overlay} behavior={Platform.OS==='ios'?'padding':undefined}>
   <View style={styles.sheet}>
    <View style={styles.header}><Text style={styles.title}>Send assets</Text><Pressable onPress={onClose}><Text style={styles.close}>×</Text></Pressable></View>
    <Text style={styles.muted}>Search for a Kivo user or paste a wallet address. Review all details before signing.</Text>
    {step==='recipient'?<><Text style={styles.label}>Search Kivo users or enter wallet address</Text>
    <TextInput value={recipient} onChangeText={v=>{setRecipient(v);setResolvedAddress('');setResolvedUsername('');}} autoCapitalize="none" autoCorrect={false} placeholder="Search by @username or wallet address" placeholderTextColor={kivoTheme.colors.textMuted} style={styles.input} accessibilityLabel="Search Kivo users or enter wallet address"/>
    {searching?<ActivityIndicator color={kivoTheme.colors.accent}/>:null}
    {matches.length>0?<View style={styles.suggestions}>{matches.map(profile=><Pressable key={profile.userId} style={styles.suggestion} onPress={()=>{setRecipient('@'+profile.username);setResolvedUsername(profile.username||'');setResolvedAddress(profile.address||(profile.userId?walletAddressOfUserId(profile.userId):''));setMatches([]);}} accessibilityRole="button"><View style={styles.suggestionAvatar}>{profile.avatarUrl?<Image source={{uri:profile.avatarUrl}} style={styles.suggestionAvatarImage} resizeMode="cover"/>:<Text style={styles.suggestionInitial}>{(profile.username||'?').slice(0,1).toUpperCase()}</Text>}</View><View style={styles.copy}><Text style={styles.assetTitle}>{profile.username||'Kivo user'}</Text><Text style={styles.muted}>@{profile.username}</Text></View></Pressable>)}</View>:null}</>:null}
    {step==='transfer'?<><View style={styles.recipientSummary}><Text style={styles.muted}>SENDING TO</Text><Text style={styles.assetTitle}>{resolvedUsername?'@'+resolvedUsername:resolvedAddress.slice(0,8)+'…'+resolvedAddress.slice(-6)}</Text></View>
    <Text style={styles.label}>Asset</Text>
    <Pressable style={styles.asset} onPress={()=>setMenuOpen(x=>!x)}><TokenIcon kind={selected?.kind||'native'} symbol={selected?.symbol||'ETH'} chainKey={(selected?.chainKey as ChainKey)||'ethereum'} address={selected?.address||ZERO} imageUrl={selected?.imageUrl} size={36}/><View style={styles.copy}><Text style={styles.assetTitle}>{selected?.symbol||'ETH'}</Text><Text style={styles.muted}>{selected?.name||'Ethereum'} · Available {fmt(selected?.amount||0)}</Text></View><Text style={styles.muted}>{menuOpen?'⌃':'⌄'}</Text></Pressable>
    {menuOpen?<ScrollView style={styles.menu} nestedScrollEnabled>{list.map(item=><Pressable key={item.key} onPress={()=>{setSelectedKey(item.key);setMenuOpen(false);}} style={[styles.option,item.key===selected?.key&&styles.active]}><TokenIcon kind={item.kind} symbol={item.symbol} chainKey={item.chainKey as ChainKey} address={item.address} imageUrl={item.imageUrl} size={32}/><View style={styles.copy}><Text style={styles.assetTitle}>{item.symbol}</Text><Text style={styles.muted}>{item.name}</Text></View><Text style={styles.balance}>{fmt(item.amount)}</Text></Pressable>)}</ScrollView>:null}
    <Text style={styles.label}>Amount</Text><TextInput value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor={kivoTheme.colors.textMuted} style={styles.input}/>
    <View style={styles.quickAmounts}>{[['10%',0.1],['25%',0.25],['50%',0.5],['Max',1]].map(([label,fraction])=><Pressable key={String(label)} style={styles.quickAmount} onPress={()=>setAmount(String(Number(((selected?.amount||0)*Number(fraction)).toFixed(8))))}><Text style={styles.quickAmountText}>{String(label)}</Text></Pressable>)}</View>
    {loading?<ActivityIndicator color={kivoTheme.colors.accent}/>:null}
    <Text style={styles.muted}>{wallet?'Wallet '+wallet.address.slice(0,6)+'…'+wallet.address.slice(-4)+(wallet.solanaAddress?' · Solana connected':''):'Unlock or import your Kivo wallet to send.'}</Text>
    </>:null}
    {step==='review'&&selected?<><Text style={styles.reviewTitle}>Review transfer</Text><View style={styles.reviewCard}><View style={styles.reviewRow}><Text style={styles.muted}>Recipient</Text><Text style={styles.reviewValue}>{resolvedUsername?'@'+resolvedUsername:resolvedAddress.slice(0,8)+'…'+resolvedAddress.slice(-6)}</Text></View><View style={styles.reviewRow}><Text style={styles.muted}>Asset / network</Text><Text style={styles.reviewValue}>{selected.symbol+' · '+(selected.chainKey==='solana'?'Solana':CHAIN_LABEL[selected.chainKey as ChainKey]||selected.chainKey)}</Text></View><View style={styles.reviewRow}><Text style={styles.muted}>Amount</Text><Text style={styles.reviewValue}>{amount+' '+selected.symbol}</Text></View><Text style={styles.muted}>Kivo covers network gas through Relay where supported. Review and sign the transfer securely on your device.</Text></View></>:null}
    {error?<Text style={styles.error}>{error}</Text>:null}
    {step!=='recipient'?<Pressable onPress={()=>{setError('');setStep(step==='review'?'transfer':'recipient');}} style={styles.back}><Text style={styles.backText}>{step==='review'?'Back to amount':'Change recipient'}</Text></Pressable>:null}
    <Pressable disabled={loading||sending} onPress={()=>void submit()} style={[styles.send,(loading||sending)&&{opacity:0.65}]}><Text style={styles.sendText}>{sending?'Waiting for wallet…':step==='recipient'?'Continue':step==='transfer'?'Review transfer':'Confirm and sign'}</Text></Pressable>
   </View>
  </KeyboardAvoidingView>
 </Modal>;
}
const styles=StyleSheet.create({
 suggestions:{maxHeight:190,borderRadius:14,borderWidth:1,borderColor:'rgba(183,226,123,0.25)',backgroundColor:'#0B1E17',overflow:'hidden'},suggestion:{minHeight:58,paddingHorizontal:10,paddingVertical:8,flexDirection:'row',alignItems:'center',gap:10,borderBottomWidth:StyleSheet.hairlineWidth,borderBottomColor:'rgba(183,226,123,0.15)'},suggestionAvatar:{width:42,height:42,borderRadius:21,overflow:'hidden',alignItems:'center',justifyContent:'center',backgroundColor:'#12372D',borderWidth:1,borderColor:'rgba(183,226,123,0.3)'},suggestionAvatarImage:{width:42,height:42,borderRadius:21},suggestionInitial:{color:kivoTheme.colors.accent,fontWeight:'800'},recipientSummary:{padding:12,borderRadius:13,borderWidth:1,borderColor:kivoTheme.colors.border,backgroundColor:'rgba(183,226,123,0.05)',gap:5},quickAmounts:{flexDirection:'row',gap:8},quickAmount:{flex:1,minHeight:38,borderRadius:10,backgroundColor:'#12372D',alignItems:'center',justifyContent:'center'},quickAmountText:{color:kivoTheme.colors.text,fontWeight:'700'},reviewTitle:{color:kivoTheme.colors.text,fontSize:19,fontWeight:'800'},reviewCard:{padding:14,borderRadius:14,borderWidth:1,borderColor:kivoTheme.colors.border,backgroundColor:'#062F2C',gap:10},reviewRow:{flexDirection:'row',justifyContent:'space-between',alignItems:'flex-start',gap:12,paddingBottom:10,borderBottomWidth:StyleSheet.hairlineWidth,borderBottomColor:kivoTheme.colors.border},reviewValue:{color:kivoTheme.colors.text,fontSize:13,fontWeight:'700',flexShrink:1,textAlign:'right'},back:{minHeight:46,alignItems:'center',justifyContent:'center'},backText:{color:kivoTheme.colors.accent,fontWeight:'700'},
 overlay:{flex:1,justifyContent:'flex-end',backgroundColor:'rgba(0,0,0,0.62)'},
 sheet:{backgroundColor:'#0B1E17',borderColor:'rgba(183,226,123,0.25)',borderWidth:1,borderTopLeftRadius:26,borderTopRightRadius:26,padding:20,gap:10,maxHeight:'94%'},
 header:{flexDirection:'row',alignItems:'center',justifyContent:'space-between'},title:{color:kivoTheme.colors.text,fontSize:22,fontWeight:'800'},close:{color:kivoTheme.colors.text,fontSize:32,lineHeight:34},
 muted:{color:kivoTheme.colors.textMuted,fontSize:12},label:{color:kivoTheme.colors.text,fontSize:14,fontWeight:'700',marginTop:3},
 input:{minHeight:52,borderRadius:15,borderWidth:1,borderColor:kivoTheme.colors.border,backgroundColor:'#062F2C',paddingHorizontal:14,color:kivoTheme.colors.text,fontSize:15},
 asset:{minHeight:64,borderRadius:16,borderWidth:1,borderColor:kivoTheme.colors.accent,backgroundColor:'#062F2C',padding:10,flexDirection:'row',alignItems:'center',gap:10},copy:{flex:1,minWidth:0},assetTitle:{color:kivoTheme.colors.text,fontWeight:'800',fontSize:15},
 menu:{maxHeight:220,borderRadius:16,borderWidth:1,borderColor:'rgba(183,226,123,0.25)',backgroundColor:'#0B1E17',padding:6},option:{minHeight:56,borderRadius:12,padding:8,flexDirection:'row',alignItems:'center',gap:10},active:{backgroundColor:'#12372D'},balance:{color:kivoTheme.colors.text,fontSize:13},
 error:{color:kivoTheme.colors.danger,fontSize:13},send:{marginTop:8,minHeight:56,borderRadius:16,alignItems:'center',justifyContent:'center',backgroundColor:kivoTheme.colors.cream},sendText:{color:'#17372B',fontWeight:'800',fontSize:16}
});
