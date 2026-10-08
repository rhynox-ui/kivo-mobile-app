import React, { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { KivoMark } from '../components/KivoMark';
import { kivoTheme } from '../theme/kivoTheme';
import { generateMnemonic } from 'viem/accounts';

export function CreateWalletScreen({ onContinue }:{onContinue:(mnemonic:string)=>void}){
 const [busy,setBusy]=useState(false);
 const create=async()=>{setBusy(true);try{const mnemonic=generateMnemonic();onContinue(mnemonic);}catch(error){Alert.alert('Wallet',error instanceof Error?error.message:'Unable to create a secure wallet.')}finally{setBusy(false)}};
 return <View style={styles.container}><View style={styles.hero}><KivoMark size={76}/><Text style={styles.title}>Create your Kivo wallet</Text><Text style={styles.body}>A local wallet keeps signing authority on your device. Your recovery phrase is never sent to Kivo.</Text></View><Pressable disabled={busy} onPress={create} style={[styles.button,busy&&styles.disabled]}>{busy?<ActivityIndicator color={kivoTheme.colors.backgroundDeep}/>:<Text style={styles.buttonText}>Generate secure wallet</Text>}</Pressable></View>
}
const styles=StyleSheet.create({container:{flex:1,backgroundColor:kivoTheme.colors.background,padding:24},hero:{flex:1,alignItems:'center',justifyContent:'center'},title:{color:kivoTheme.colors.text,fontSize:29,fontWeight:'800',textAlign:'center',marginTop:28},body:{color:kivoTheme.colors.textMuted,fontSize:14,lineHeight:21,textAlign:'center',marginTop:10,maxWidth:330},button:{height:58,borderRadius:29,backgroundColor:kivoTheme.colors.cream,alignItems:'center',justifyContent:'center',marginBottom:12},disabled:{opacity:.6},buttonText:{color:kivoTheme.colors.backgroundDeep,fontWeight:'800'}});