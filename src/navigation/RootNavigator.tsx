import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { NavigationContainer, type NavigatorScreenParams } from '@react-navigation/native';
import {
  createNativeStackNavigator,
  type NativeStackScreenProps,
} from '@react-navigation/native-stack';
import { SplashScreen } from '../screens/SplashScreen';
import { OnboardingScreen } from '../screens/OnboardingScreen';
import { WalletSetupScreen } from '../screens/WalletSetupScreen';
import { CreateWalletScreen } from '../screens/CreateWalletScreen';
import { ImportWalletScreen } from '../screens/ImportWalletScreen';
import { RecoveryBackupScreen } from '../screens/RecoveryBackupScreen';
import { VerifyRecoveryScreen } from '../screens/VerifyRecoveryScreen';
import { BiometricScreen } from '../screens/BiometricScreen';
import { ProfileSetupScreen } from '../screens/ProfileSetupScreen';
import { MainShell } from '../screens/MainShell';
import { kivoTheme } from '../theme/kivoTheme';
import { loadWalletSession } from '../state/walletStore';
import { startKivoSession } from '../state/session';

export type RootStackParamList = {
  Splash: undefined;
  Onboarding: undefined;
  WalletSetup: undefined;
  CreateWallet: undefined;
  ImportWallet: undefined;
  RecoveryBackup: { mnemonic: string };
  VerifyRecovery: { mnemonic: string };
  Biometrics: undefined;
  ProfileSetup: undefined;
  Home: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

function SplashRoute({ navigation }: NativeStackScreenProps<RootStackParamList, 'Splash'>) {
  // Restore the session while the splash plays; navigate when both are done.
  const [target, setTarget] = useState<'Home' | 'Onboarding' | null>(null);
  const [animationDone, setAnimationDone] = useState(false);
  const [quick, setQuick] = useState<boolean | null>(null);
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        await startKivoSession();
        const wallet = await loadWalletSession();
        if (!mounted) return;
        setQuick(Boolean(wallet));
        setTarget(wallet ? 'Home' : 'Onboarding');
      } catch {
        if (mounted) { setQuick(false); setTarget('Onboarding'); }
      }
    })();
    return () => { mounted = false; };
  }, []);
  useEffect(() => { if (target && animationDone) navigation.replace(target); }, [target, animationDone, navigation]);
  if (quick === null) return <View style={{ flex: 1, backgroundColor: kivoTheme.colors.backgroundDeep }} />;
  return <SplashScreen quick={quick} onDone={() => setAnimationDone(true)} />;
}

export function RootNavigator() {
  return (
    <NavigationContainer>
      <Stack.Navigator
        initialRouteName="Splash"
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: kivoTheme.colors.background },
          animation: 'fade',
        }}
      >
        <Stack.Screen name="Splash" component={SplashRoute} />
        <Stack.Screen
          name="Onboarding"
          component={({ navigation }: NativeStackScreenProps<RootStackParamList, 'Onboarding'>) => (
            <OnboardingScreen onDone={() => navigation.replace('WalletSetup')} />
          )}
        />
        <Stack.Screen
          name="WalletSetup"
          component={({ navigation }: NativeStackScreenProps<RootStackParamList, 'WalletSetup'>) => (
            <WalletSetupScreen
              onCreate={() => navigation.navigate('CreateWallet')}
              onImport={() => navigation.navigate('ImportWallet')}
            />
          )}
        />
        <Stack.Screen
          name="CreateWallet"
          component={({ navigation }: NativeStackScreenProps<RootStackParamList, 'CreateWallet'>) => (
            <CreateWalletScreen onContinue={mnemonic => navigation.navigate('RecoveryBackup', { mnemonic })} />
          )}
        />
        <Stack.Screen
          name="ImportWallet"
          component={({ navigation }: NativeStackScreenProps<RootStackParamList, 'ImportWallet'>) => (
            <ImportWalletScreen onBack={() => navigation.goBack()} onDone={() => navigation.navigate('ProfileSetup')} />
          )}
        />
        <Stack.Screen
          name="RecoveryBackup"
          component={({ navigation, route }: NativeStackScreenProps<RootStackParamList, 'RecoveryBackup'>) => (
            <RecoveryBackupScreen mnemonic={route.params.mnemonic} onContinue={() => navigation.navigate('VerifyRecovery', { mnemonic: route.params.mnemonic })} />
          )}
        />
        <Stack.Screen
          name="VerifyRecovery"
          component={({ navigation, route }: NativeStackScreenProps<RootStackParamList, 'VerifyRecovery'>) => (
            <VerifyRecoveryScreen mnemonic={route.params.mnemonic} onContinue={() => navigation.navigate('Biometrics')} />
          )}
        />
        <Stack.Screen
          name="Biometrics"
          component={({ navigation }: NativeStackScreenProps<RootStackParamList, 'Biometrics'>) => (
            <BiometricScreen onContinue={() => navigation.navigate('ProfileSetup')} />
          )}
        />
        <Stack.Screen
          name="ProfileSetup"
          component={({ navigation }: NativeStackScreenProps<RootStackParamList, 'ProfileSetup'>) => (
            <ProfileSetupScreen onDone={() => navigation.replace('Home')} />
          )}
        />
        <Stack.Screen name="Home">{({ navigation }) => <MainShell onLogout={() => navigation.replace('WalletSetup')} />}</Stack.Screen>
      </Stack.Navigator>
    </NavigationContainer>
  );
}

export type RootNavigation = NavigatorScreenParams<RootStackParamList>;
