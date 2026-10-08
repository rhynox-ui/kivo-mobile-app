// Mango Pro parity: dedicated biometric credential service.
// Kivo has no app password/vault layer, so the wallet mnemonic itself is
// moved into a separate Keychain/Keystore item protected by the same
// BIOMETRY_ANY_OR_DEVICE_PASSCODE policy Mango Pro uses.

import * as Keychain from 'react-native-keychain';

const SERVICE = 'com.kivo.chat.biometric-wallet';
const USERNAME = 'kivo-wallet';

const BIOMETRY_LABELS: Partial<Record<Keychain.BIOMETRY_TYPE, string>> = {
  [Keychain.BIOMETRY_TYPE.FINGERPRINT]: 'fingerprint',
  [Keychain.BIOMETRY_TYPE.FACE]: 'face',
  [Keychain.BIOMETRY_TYPE.IRIS]: 'iris',
  [Keychain.BIOMETRY_TYPE.FACE_ID]: 'Face ID',
  [Keychain.BIOMETRY_TYPE.TOUCH_ID]: 'Touch ID',
};

export async function getBiometryLabel(): Promise<string> {
  try {
    const type = await Keychain.getSupportedBiometryType();
    return (type && BIOMETRY_LABELS[type]) ?? 'biometric';
  } catch {
    return 'biometric';
  }
}

export async function isBiometricAvailable(): Promise<boolean> {
  try {
    const type = await Keychain.getSupportedBiometryType();
    if (type !== null) return true;
    return await Keychain.isPasscodeAuthAvailable();
  } catch {
    return false;
  }
}

export async function isBiometricUnlockEnabled(): Promise<boolean> {
  try {
    return Boolean(await Keychain.hasGenericPassword({service: SERVICE}));
  } catch {
    return false;
  }
}

export async function enableBiometricUnlock(mnemonic: string): Promise<boolean> {
  await Keychain.setGenericPassword(USERNAME, mnemonic, {
    service: SERVICE,
    accessControl: Keychain.ACCESS_CONTROL.BIOMETRY_ANY_OR_DEVICE_PASSCODE,
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });

  const check = await Keychain.getGenericPassword({
    service: SERVICE,
    authenticationPrompt: {
      title: 'Enable Kivo unlock',
      subtitle: 'Use your biometrics or device passcode',
      cancel: 'Cancel',
    },
  });
  if (!check) {
    await Keychain.resetGenericPassword({service: SERVICE});
    return false;
  }
  return true;
}

export async function disableBiometricUnlock(): Promise<string | null> {
  try {
    const credentials = await Keychain.getGenericPassword({
      service: SERVICE,
      authenticationPrompt: {
        title: 'Disable Kivo biometric unlock',
        subtitle: 'Authenticate to change wallet security',
        cancel: 'Cancel',
      },
    });
    if (!credentials) return null;
    await Keychain.resetGenericPassword({service: SERVICE});
    return credentials.password;
  } catch {
    return null;
  }
}

export async function getBiometricPassword(): Promise<string | null> {
  try {
    const result = await Keychain.getGenericPassword({
      service: SERVICE,
      authenticationPrompt: {
        title: 'Unlock Kivo',
        subtitle: 'Use your biometrics or device passcode to unlock your wallet',
        cancel: 'Use another unlock method',
      },
    });
    return result ? result.password : null;
  } catch {
    return null;
  }
}

export async function clearBiometricUnlock(): Promise<void> {
  await Keychain.resetGenericPassword({service: SERVICE}).catch(() => {});
}
