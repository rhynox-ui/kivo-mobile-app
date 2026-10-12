import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { kivoAlert } from '../components/KivoAlert';
import { kivoTheme } from '../theme/kivoTheme';
import { isValidRecoveryWord } from '../state/walletStore';

export function VerifyRecoveryScreen({mnemonic,onContinue}:{mnemonic:string;onContinue:()=>void}){
 const [value,setValue]=useState('');
 const valid=Boolean(value.trim());
 const verify=()=>{if(!isValidRecoveryWord(mnemonic,3,value)){kivoAlert('Backup check','That word does not match word #4. Check your written backup and try again.');return;}onContinue();};
 return <View style={styles.container}><Text style={styles.step}>SECURITY • 02</Text><Text style={styles.title}>Verify your backup</Text><Text style={styles.body}>Enter word #4 from the recovery phrase you just backed up.</Text><Text style={styles.label}>Word #4</Text><TextInput value={value} onChangeText={setValue} placeholder="Enter recovery word" placeholderTextColor={kivoTheme.colors.textMuted} autoCapitalize="none" autoCorrect={false} spellCheck={false} autoComplete="off" importantForAutofill="no" textContentType="none" style={styles.input}/><Pressable onPress={verify} disabled={!valid} style={[styles.button,!valid&&styles.disabled]}><Text style={styles.buttonText}>Verify backup</Text></Pressable></View>
}
const styles=StyleSheet.create({container:{flex:1,backgroundColor:kivoTheme.colors.background,padding:24},step:{color:kivoTheme.colors.accent,fontSize:11,fontWeight:'800',letterSpacing:1.6,marginTop:24},title:{color:kivoTheme.colors.text,fontSize:30,fontWeight:'700',marginTop:10},body:{color:kivoTheme.colors.textMuted,fontSize:15,lineHeight:22,marginTop:10},label:{color:kivoTheme.colors.text,fontSize:13,fontWeight:'700',marginTop:48,marginBottom:8},input:{height:58,borderRadius:16,borderWidth:1,borderColor:kivoTheme.colors.border,backgroundColor:kivoTheme.colors.surface,color:kivoTheme.colors.text,paddingHorizontal:16,fontSize:16},button:{height:58,borderRadius:29,backgroundColor:kivoTheme.colors.cream,alignItems:'center',justifyContent:'center',marginTop:'auto',marginBottom:12},disabled:{opacity:.4},buttonText:{color:kivoTheme.colors.backgroundDeep,fontWeight:'700',fontSize:15}});
