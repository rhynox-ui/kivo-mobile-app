import React,{useCallback,useEffect,useState}from'react';
import{BackHandler,Pressable,StyleSheet,Text,TextInput,View}from'react-native';
import{kivoTheme}from'../theme/kivoTheme';
import{setScreenSecure}from'./screenSecurity';
import{loadVault,unlockVaultMnemonic}from'./vault';

// Drawn inside the current screen (not a separate <Modal> window) so the
// activity's FLAG_SECURE covers it. The phrase only lives while this component
// is mounted: the parent mounts it on demand and every close path unmounts it.
export function RevealPhraseModal({visible,onClose}:{visible:boolean;onClose:()=>void}){
  const[p,setP]=useState('');const[m,setM]=useState('');const[e,setE]=useState('');
  const close=useCallback(()=>{setM('');setP('');void setScreenSecure(false);onClose();},[onClose]);
  useEffect(()=>{if(!visible){setM('');setP('');}},[visible]);
  useEffect(()=>()=>{void setScreenSecure(false);},[]);
  useEffect(()=>{if(!visible)return;const sub=BackHandler.addEventListener('hardwareBackPress',()=>{close();return true;});return()=>sub.remove();},[visible,close]);
  const go=async()=>{try{const secure=await setScreenSecure(true);if(!secure)throw new Error('Unable to secure this screen. Recovery phrase will not be displayed.');const v=await loadVault();if(!v)throw new Error('No wallet found.');setM(await unlockVaultMnemonic(v,p));setP('');setE('');}catch(x){setE(x instanceof Error?x.message:'Incorrect password.')}};
  if(!visible)return null;
  return <View style={s.o}><View style={s.c}><Text style={s.t}>Recovery phrase</Text>{!m?<><Text style={s.h}>Confirm your password to view this wallet's recovery phrase.</Text><TextInput value={p}onChangeText={setP}placeholder="Password"placeholderTextColor={kivoTheme.colors.textMuted}secureTextEntry style={s.i}/>{e?<Text style={s.e}>{e}</Text>:null}<Pressable onPress={go}disabled={!p}style={s.b}><Text style={s.bt}>Continue</Text></Pressable></>:<><Text style={s.h}>Anyone with these words can take everything in this wallet.</Text><View style={s.g}>{m.split(' ').map((w,i)=><Text key={i}style={s.w}>{i+1}. {w}</Text>)}</View><Pressable onPress={close}style={s.b}><Text style={s.bt}>Done</Text></Pressable></>}<Pressable onPress={close}style={s.x}><Text style={s.h}>Close</Text></Pressable></View></View>;
}
const s=StyleSheet.create({o:{position:'absolute',top:0,left:0,right:0,bottom:0,zIndex:50,elevation:50,backgroundColor:'rgba(0,0,0,.55)',justifyContent:'center',padding:18},c:{backgroundColor:kivoTheme.colors.surface,borderWidth:1,borderColor:kivoTheme.colors.border,borderRadius:20,padding:18,maxHeight:'92%'},t:{color:kivoTheme.colors.text,fontSize:18,fontWeight:'800',marginBottom:12},h:{color:kivoTheme.colors.textMuted,fontSize:13,lineHeight:19,marginBottom:12},i:{height:52,borderWidth:1,borderColor:kivoTheme.colors.border,borderRadius:12,color:kivoTheme.colors.text,paddingHorizontal:14},e:{color:'#E0443E',fontSize:12,marginTop:8},b:{marginTop:14,height:50,borderRadius:25,backgroundColor:kivoTheme.colors.cream,alignItems:'center',justifyContent:'center'},bt:{color:kivoTheme.colors.backgroundDeep,fontWeight:'800'},k:{backgroundColor:kivoTheme.colors.background,borderRadius:12,padding:10,marginTop:8},l:{color:kivoTheme.colors.text,fontWeight:'800',marginBottom:5},sec:{color:kivoTheme.colors.textMuted,fontSize:10},g:{backgroundColor:kivoTheme.colors.background,padding:12,borderRadius:12,flexDirection:'row',flexWrap:'wrap'},w:{width:'50%',color:kivoTheme.colors.text,fontSize:13,paddingVertical:5},x:{alignItems:'center',paddingTop:12}});
