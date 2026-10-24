import React, { useEffect, useRef, useState } from 'react';
import { AppState, View } from 'react-native';
import {
  NavigationContainer,
  type NavigatorScreenParams,
  useNavigationContainerRef,
} from '@react-navigation/native';
import {
  createNativeStackNavigator,
  type NativeStackScreenProps,
} from '@react-navigation/native-stack';
import { SplashScreen } from '../screens/SplashScreen';
import { OnboardingScreen } from '../screens/OnboardingScreen';
import { WalletSetupScreen } from '../screens/WalletSetupScreen';
import { CreateWalletScreen } from '../screens/CreateWalletScreen';
import { ImportWalletScreen } from '../screens/ImportWalletScreen';
import { GoogleWalletScreen } from '../screens/GoogleWalletScreen';
import { RecoveryBackupScreen } from '../screens/RecoveryBackupScreen';
import { VerifyRecoveryScreen } from '../screens/VerifyRecoveryScreen';
import { BiometricScreen } from '../screens/BiometricScreen';
import { BiometricUnlockScreen } from '../screens/BiometricUnlockScreen';
import { WalletUnlockScreen } from '../screens/WalletUnlockScreen';
import { LegacyMigrationScreen } from '../screens/LegacyMigrationScreen';
import { PasswordSetupScreen } from '../screens/PasswordSetupScreen';
import { ProfileSetupScreen } from '../screens/ProfileSetupScreen';
import { ReferralOnboardingScreen } from '../screens/ReferralOnboardingScreen';
import { MainShell } from '../screens/MainShell';
import { kivoTheme } from '../theme/kivoTheme';
import { getWalletSession, clearLocalWallet, lockWalletSession } from '../state/walletStore';
import { api, hasExistingProfile, startKivoSession } from '../state/session';
import { startReferralSync } from '../state/referrals';
import {
  getLegacyMnemonic,
  hasVault,
  VaultUnavailableError,
  VaultCorruptError,
} from '../wallet/vault';
import { isBiometricUnlockEnabled } from '../wallet/biometricAuth';
import { loadAutoLockMs } from '../settings/autoLockPrefs';
import { fetchCashBalances } from '@kivo/trading/kivo/balances';
import { checkForDeposits } from '../wallet/depositWatcher';
import { runAutoSweep } from '../wallet/autoSweep';
import { CHAIN_LABEL } from '@kivo/trading/core/chainData';
import { recordDiagnosticEvent } from '../debug/diagnosticLog';

export type RootStackParamList = {
  Splash: undefined;
  Onboarding: undefined;
  WalletSetup: undefined;
  CreateWallet: undefined;
  ImportWallet: undefined;
  GoogleWallet: undefined;
  RecoveryBackup: { mnemonic: string };
  VerifyRecovery: { mnemonic: string };
  PasswordSetup: { mnemonic: string; mode: 'create' | 'import' };
  LegacyMigration: undefined;
  Biometrics: { password: string };
  BiometricUnlock: undefined;
  WalletUnlock: undefined;
  ProfileSetup: undefined;
  ReferralOnboarding: undefined;
  Home: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

function SplashRoute({ navigation }: NativeStackScreenProps<RootStackParamList, 'Splash'>) {
  const [target, setTarget] = useState<
    'Home' | 'Onboarding' | 'BiometricUnlock' | 'WalletUnlock' | 'LegacyMigration' | null
  >(null);
  const [animationDone, setAnimationDone] = useState(false);
  const [quick, setQuick] = useState<boolean | null>(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        await startKivoSession();
        startReferralSync();
        const vault = await hasVault();
        if (!mounted) return;
        if (!vault) {
          const legacy = await getLegacyMnemonic();
          if (!mounted) return;
          setQuick(Boolean(legacy));
          setTarget(legacy ? 'LegacyMigration' : 'Onboarding');
          return;
        }
        const bio = await isBiometricUnlockEnabled();
        setQuick(true);
        setTarget(bio ? 'BiometricUnlock' : 'WalletUnlock');
      } catch (error) {
        if (mounted) {
          setQuick(false);
          // A keychain read error is not "no wallet": retry in unlock, never go to onboarding.
          setTarget(
            error instanceof VaultUnavailableError || error instanceof VaultCorruptError
              ? 'WalletUnlock'
              : 'Onboarding',
          );
        }
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (target && animationDone) navigation.replace(target);
  }, [target, animationDone, navigation]);

  if (quick === null) {
    return <View style={{ flex: 1, backgroundColor: kivoTheme.colors.backgroundDeep }} />;
  }
  return <SplashScreen quick={quick} onDone={() => setAnimationDone(true)} />;
}

export function RootNavigator() {
  const navigationRef = useNavigationContainerRef<RootStackParamList>();
  const lockTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backgroundedAt = useRef<number | null>(null);

  useEffect(() => {
    const clear = () => {
      if (lockTimer.current) {
        clearTimeout(lockTimer.current);
        lockTimer.current = null;
      }
    };

    const subscription = AppState.addEventListener('change', async (state) => {
      const lock = async () => {
        clear();
        backgroundedAt.current = null;
        if (!getWalletSession() || !navigationRef.isReady()) return;
        lockWalletSession();
        const bio = await isBiometricUnlockEnabled();
        navigationRef.reset({
          index: 0,
          routes: [{ name: bio ? 'BiometricUnlock' : 'WalletUnlock' }],
        });
      };

      // JS timers pause in the background, so measure the delay with wall-clock time on resume.
      if (state === 'active') {
        clear();
        const since = backgroundedAt.current;
        backgroundedAt.current = null;
        if (since === null || !getWalletSession()) return;
        const ms = await loadAutoLockMs();
        if (Date.now() - since >= ms) await lock();
        return;
      }

      if (state !== 'background' && state !== 'inactive') return;
      if (!getWalletSession() || !navigationRef.isReady()) return;
      if (backgroundedAt.current === null) backgroundedAt.current = Date.now();
      const ms = await loadAutoLockMs();
      if (ms === 0) {
        await lock();
      } else {
        clear();
        lockTimer.current = setTimeout(() => {
          void lock();
        }, ms);
      }
    });

    return () => {
      clear();
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    let active = true;
    const check = async () => {
      if (!active) return;
      const wallet = getWalletSession();
      if (!wallet) return;
      try {
        const rows = await fetchCashBalances(wallet.address, undefined, wallet.solanaAddress, {
          forceFresh: true,
        });
        const readings: Record<string, number> = {};
        for (const row of rows) {
          if (row.status === 'ok') {
            readings[CHAIN_LABEL[row.chainKey] ?? row.chainKey] = row.balance.amount;
          }
        }
        await checkForDeposits(wallet.address, readings);
        // Funds that landed on another network go home (USDC on Solana) by themselves.
        void runAutoSweep({ background: true });
      } catch {
        void recordDiagnosticEvent(
          'depositWatcher.poll',
          new Error('Deposit balance polling failed.'),
        );
      }
    };

    void check();
    const timer = setInterval(() => {
      void check();
    }, 60000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  return (
    <NavigationContainer ref={navigationRef}>
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
              onGoogle={() => navigation.navigate('GoogleWallet')}
              onCreate={() => navigation.navigate('CreateWallet')}
              onImport={() => navigation.navigate('ImportWallet')}
            />
          )}
        />
        <Stack.Screen
          name="CreateWallet"
          component={({ navigation }: NativeStackScreenProps<RootStackParamList, 'CreateWallet'>) => (
            <CreateWalletScreen
              onContinue={(mnemonic) => navigation.navigate('RecoveryBackup', { mnemonic })}
            />
          )}
        />
        <Stack.Screen
          name="ImportWallet"
          component={({ navigation }: NativeStackScreenProps<RootStackParamList, 'ImportWallet'>) => (
            <ImportWalletScreen
              onBack={() => navigation.goBack()}
              onDone={() => navigation.reset({ index: 0, routes: [{ name: 'Home' }] })}
              onPassword={(mnemonic) =>
                navigation.navigate('PasswordSetup', { mnemonic, mode: 'import' })
              }
            />
          )}
        />
        <Stack.Screen
          name="GoogleWallet"
          component={({ navigation }: NativeStackScreenProps<RootStackParamList, 'GoogleWallet'>) => (
            <GoogleWalletScreen
              onBack={() => navigation.goBack()}
              onUsePhrase={() => navigation.replace('ImportWallet')}
              onDone={(password) =>
                navigation.reset({
                  index: 0,
                  routes: [{ name: 'Biometrics', params: { password } }],
                })
              }
            />
          )}
        />
        <Stack.Screen
          name="RecoveryBackup"
          component={({
            navigation,
            route,
          }: NativeStackScreenProps<RootStackParamList, 'RecoveryBackup'>) => (
            <RecoveryBackupScreen
              mnemonic={route.params.mnemonic}
              onBack={() => navigation.goBack()}
              onContinue={() =>
                navigation.navigate('PasswordSetup', {
                  mnemonic: route.params.mnemonic,
                  mode: 'create',
                })
              }
            />
          )}
        />
        <Stack.Screen
          name="VerifyRecovery"
          component={({
            navigation,
            route,
          }: NativeStackScreenProps<RootStackParamList, 'VerifyRecovery'>) => (
            <VerifyRecoveryScreen
              mnemonic={route.params.mnemonic}
              onContinue={() =>
                navigation.navigate('PasswordSetup', {
                  mnemonic: route.params.mnemonic,
                  mode: 'create',
                })
              }
            />
          )}
        />
        <Stack.Screen
          name="PasswordSetup"
          component={({
            navigation,
            route,
          }: NativeStackScreenProps<RootStackParamList, 'PasswordSetup'>) => (
            <PasswordSetupScreen
              mnemonic={route.params.mnemonic}
              mode={route.params.mode}
              onBack={() => navigation.goBack()}
              onDone={(password) =>
                navigation.reset({
                  index: 0,
                  routes: [{ name: 'Biometrics', params: { password } }],
                })
              }
            />
          )}
        />
        <Stack.Screen
          name="Biometrics"
          component={({
            navigation,
            route,
          }: NativeStackScreenProps<RootStackParamList, 'Biometrics'>) => (
            <BiometricScreen
              password={route.params.password}
              // An imported or restored wallet keeps its Kivo profile: go straight home.
              onContinue={() => { void hasExistingProfile().then(existing => navigation.replace(existing ? 'Home' : 'ProfileSetup')); }}
            />
          )}
        />
        <Stack.Screen
          name="BiometricUnlock"
          component={({ navigation }: NativeStackScreenProps<RootStackParamList, 'BiometricUnlock'>) => (
            <BiometricUnlockScreen onUnlocked={() => navigation.replace('Home')} />
          )}
        />
        <Stack.Screen
          name="WalletUnlock"
          component={({ navigation }: NativeStackScreenProps<RootStackParamList, 'WalletUnlock'>) => (
            <WalletUnlockScreen onUnlocked={() => navigation.replace('Home')} />
          )}
        />
        <Stack.Screen
          name="LegacyMigration"
          component={({ navigation }: NativeStackScreenProps<RootStackParamList, 'LegacyMigration'>) => (
            <LegacyMigrationScreen
              onDone={(password) => navigation.replace('Biometrics', { password })}
            />
          )}
        />
        <Stack.Screen
          name="ProfileSetup"
          component={({ navigation }: NativeStackScreenProps<RootStackParamList, 'ProfileSetup'>) => (
            <ProfileSetupScreen onDone={() => navigation.replace('ReferralOnboarding')} />
          )}
        />
        <Stack.Screen
          name="ReferralOnboarding"
          component={({ navigation }: NativeStackScreenProps<RootStackParamList, 'ReferralOnboarding'>) => (
            <ReferralOnboardingScreen
              onBack={() => navigation.goBack()}
              onDone={() => navigation.replace('Home')}
            />
          )}
        />
        <Stack.Screen name="Home">
          {({ navigation }) => (
            <MainShell
              onLogout={async () => {
                await api.signOut();
                await clearLocalWallet();
                navigation.replace('WalletSetup');
              }}
            />
          )}
        </Stack.Screen>
      </Stack.Navigator>
    </NavigationContainer>
  );
}

export type RootNavigation = NavigatorScreenParams<RootStackParamList>;
