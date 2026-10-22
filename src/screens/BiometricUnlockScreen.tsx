import React, {useState} from 'react';
import {ActivityIndicator, Image, Pressable, StyleSheet, Text, TextInput, View} from 'react-native';
import {kivoTheme} from '../theme/kivoTheme';
import {getBiometryLabel} from '../wallet/biometricAuth';
import {unlockWalletWithBiometric, unlockWalletWithPassword} from '../state/walletStore';

const KIVO_MARK = require('../assets/kivo-logo.png');

export function BiometricUnlockScreen({onUnlocked}: {onUnlocked: () => void}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [label, setLabel] = useState('biometric');
  const [password, setPassword] = useState('');

  const unlock = async () => {
    setBusy(true);
    setError('');
    try {
      await unlockWalletWithBiometric();
      onUnlocked();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to unlock wallet. Enter your password below to try another way.');
    } finally {
      setBusy(false);
    }
  };

  const unlockWithPassword = async () => {
    if (!password || busy) return;
    setBusy(true);
    setError('');
    try {
      await unlockWalletWithPassword(password);
      setPassword('');
      onUnlocked();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Incorrect password.');
    } finally {
      setBusy(false);
    }
  };

  React.useEffect(() => {
    let cancelled = false;
    const task = setTimeout(async () => {
      // Match Mango's flow: let the lock screen finish mounting before
      // opening the native Keychain/biometric prompt. Do not race the
      // prompt with getSupportedBiometryType(), which can make Android
      // Keychain authentication appear to hang on some devices.
      await unlock();
      if (!cancelled) {
        getBiometryLabel().then(value => {
          if (!cancelled) setLabel(value);
        });
      }
    });
    return () => {
      cancelled = true;
      clearTimeout(task);
    };
  }, []);

  return (
    <View style={styles.container}>
      <View style={styles.hero}>
        <View style={styles.icon}><Image source={KIVO_MARK} resizeMode="contain" style={styles.logo} /></View>
        <Text style={styles.title}>Unlock Kivo</Text>
        <Text style={styles.body}>Use your {label} or device passcode to unlock your wallet.</Text>
        {!!error && <Text style={styles.error}>{error}</Text>}
        <Pressable disabled={busy} onPress={unlock} style={[styles.primary, styles.biometricButton, busy && styles.disabled]}>
          {busy ? <ActivityIndicator color={kivoTheme.colors.backgroundDeep}/> : <Text style={styles.primaryText}>Scan {label === 'Face ID' || label === 'Touch ID' ? label : 'Face ID / Fingerprint'}</Text>}
        </Pressable>
        <Text style={styles.orText}>Or unlock with your Kivo password</Text>
        <TextInput
          value={password}
          onChangeText={setPassword}
          placeholder="Enter Kivo Password"
          placeholderTextColor={kivoTheme.colors.textMuted}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          textContentType="none"
          editable={!busy}
          returnKeyType="done"
          onSubmitEditing={() => void unlockWithPassword()}
          style={styles.passwordInput}
        />
        <Pressable disabled={!password || busy} onPress={() => void unlockWithPassword()} style={[styles.primary, (!password || busy) && styles.disabled]}>
          {busy ? <ActivityIndicator color={kivoTheme.colors.backgroundDeep}/> : <Text style={styles.primaryText}>Unlock with password</Text>}
        </Pressable>
      </View>
    </View>
  );
}

const styles=StyleSheet.create({
  container:{flex:1,backgroundColor:kivoTheme.colors.background,padding:24},
  hero:{flex:1,alignItems:'center',justifyContent:'center'},
  icon:{width:132,height:132,borderRadius:40,backgroundColor:'rgba(183,226,123,0.08)',alignItems:'center',justifyContent:'center'},
  logo:{width:82,height:82,borderRadius:22},
  title:{color:kivoTheme.colors.text,fontSize:30,fontWeight:'700',marginTop:36,textAlign:'center'},
  body:{color:kivoTheme.colors.textMuted,fontSize:15,lineHeight:23,textAlign:'center',maxWidth:320,marginTop:12},
  error:{color:'#E0443E',fontSize:13,textAlign:'center',marginTop:16,maxWidth:320},
  primary:{height:58,borderRadius:29,backgroundColor:kivoTheme.colors.cream,alignItems:'center',justifyContent:'center',width:'100%'},
  biometricButton:{marginTop:24},
  orText:{color:kivoTheme.colors.textMuted,fontSize:13,textAlign:'center',marginTop:18,marginBottom:10},
  passwordInput:{height:54,width:'100%',borderWidth:1,borderColor:kivoTheme.colors.border,borderRadius:14,backgroundColor:kivoTheme.colors.surface,color:kivoTheme.colors.text,paddingHorizontal:16,marginBottom:12},
  disabled:{opacity:.6},
  primaryText:{color:kivoTheme.colors.backgroundDeep,fontWeight:'700'},
});
