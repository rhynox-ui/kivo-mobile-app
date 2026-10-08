import React,{useState}from'react';
import{StyleSheet,Text,View}from'react-native';
import{kivoTheme}from'../theme/kivoTheme';
import{checkPasswordPolicy,MIN_PASSWORD_LENGTH}from'../wallet/passwordPolicy';
import{createLocalWallet,importLocalWallet}from'../state/walletStore';
import{ErrorText,PasswordField,PrimaryButton,RequirementRow}from'../onboarding/ui';

export function PasswordSetupScreen({mnemonic,mode,onDone,onBack}:{mnemonic:string;mode:'create'|'import';onDone:(password:string)=>void;onBack:()=>void}){
 const[p,setP]=useState('');const[c,setC]=useState('');const[busy,setBusy]=useState(false);const[error,setError]=useState('');
 const{longEnough,notCommon}=checkPasswordPolicy(p);const passwordsMatch=p.length>0&&c===p;const canSubmit=longEnough&&notCommon&&passwordsMatch&&!busy;
 async function submit(){setBusy(true);setError('');await new Promise(resolve=>setTimeout(resolve,0));try{if(mode==='create')await createLocalWallet(mnemonic,p);else await importLocalWallet(mnemonic,p);onDone(p);}catch(e){setError(e instanceof Error?e.message:'Unable to secure wallet.');}setBusy(false);}
 return <View style={styles.root}>
  <View>
   <Text style={styles.title}>Secure your Kivo wallet</Text>
   <Text style={styles.body}>Kivo has moved to the Mango Pro password-encrypted wallet vault. Set a password now to keep this existing wallet.</Text>
   <View style={styles.field}><PasswordField value={p} onChangeText={setP} placeholder="Password" autoFocus/></View>
   <View style={styles.field}><PasswordField value={c} onChangeText={setC} placeholder="Confirm password"/></View>
   <View style={styles.checklist}>
    <RequirementRow met={longEnough}>At least {MIN_PASSWORD_LENGTH} characters</RequirementRow>
    <RequirementRow met={notCommon}>Not a commonly used password</RequirementRow>
    <RequirementRow met={passwordsMatch}>Passwords match</RequirementRow>
   </View>
   <ErrorText>{error}</ErrorText>
  </View>
  <View style={styles.footer}>
   {busy?<Text style={styles.busyHint}>Encrypting your wallet on this device — this can take a moment, please don't close the app.</Text>:null}
   <PrimaryButton onPress={submit} disabled={!canSubmit} loading={busy}>{canSubmit?'Secure wallet':!longEnough?'Enter a password':'Confirm password to continue'}</PrimaryButton>
  </View>
 </View>;
}
const styles=StyleSheet.create({root:{flex:1,backgroundColor:kivoTheme.colors.background,padding:24,justifyContent:'space-between'},title:{color:kivoTheme.colors.text,fontSize:30,lineHeight:36,fontWeight:'800',marginTop:42},body:{color:kivoTheme.colors.textMuted,fontSize:14,lineHeight:21,marginTop:10,marginBottom:18},field:{marginBottom:0},checklist:{gap:6,marginTop:4,marginBottom:6},footer:{paddingBottom:12,gap:10},busyHint:{color:kivoTheme.colors.textMuted,fontSize:12,textAlign:'center',lineHeight:17}});