import React, {useState} from 'react';
import {ActivityIndicator, Image, InteractionManager, Pressable, StyleSheet, Text, View} from 'react-native';
import {kivoTheme} from '../theme/kivoTheme';
import {getBiometryLabel} from '../wallet/biometricAuth';
import {unlockWalletWithBiometric} from '../state/walletStore';

const KIVO_MARK = require('../assets/kivo-logo.png');

export function BiometricUnlockScreen({onUnlocked}: {onUnlocked: () => void}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [label, setLabel] = useState('biometric');

  const unlock = async () => {
    setBusy(true);
    setError('');
    try {
      await unlockWalletWithBiometric();
      onUnlocked();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to unlock wallet.');
    } finally {
      setBusy(false);
    }
  };

  React.useEffect(() => {
    let cancelled = false;
    const task = InteractionManager.runAfterInteractions(async () => {
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
      task.cancel();
    };
  }, []);

  return (
    <View style={styles.container}>
      <View style={styles.hero}>
        <View style={styles.icon}><Image source={KIVO_MARK} resizeMode="contain" style={styles.logo} /></View>
        <Text style={styles.title}>Unlock Kivo</Text>
        <Text style={styles.body}>Use your {label} or device passcode to unlock your wallet.</Text>
        {!!error && <Text style={styles.error}>{error}</Text>}
      </View>
      <Pressable disabled={busy} onPress={unlock} style={[styles.primary, busy && styles.disabled]}>
        {busy ? <ActivityIndicator color={kivoTheme.colors.backgroundDeep}/> : <Text style={styles.primaryText}>Unlock</Text>}
      </Pressable>
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
  primary:{height:58,borderRadius:29,backgroundColor:kivoTheme.colors.cream,alignItems:'center',justifyContent:'center'},
  disabled:{opacity:.6},
  primaryText:{color:kivoTheme.colors.backgroundDeep,fontWeight:'700'},
});
