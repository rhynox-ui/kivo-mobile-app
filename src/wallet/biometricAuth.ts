import * as Keychain from 'react-native-keychain';
const SERVICE='com.kivo.chat.biometric-wallet';
const USERNAME='kivo-wallet';
const BIOMETRY_LABELS:Partial<Record<Keychain.BIOMETRY_TYPE,string>>={[Keychain.BIOMETRY_TYPE.FINGERPRINT]:'fingerprint',[Keychain.BIOMETRY_TYPE.FACE]:'face',[Keychain.BIOMETRY_TYPE.IRIS]:'iris',[Keychain.BIOMETRY_TYPE.FACE_ID]:'Face ID',[Keychain.BIOMETRY_TYPE.TOUCH_ID]:'Touch ID'};
export async function getBiometryLabel(){try{const t=await Keychain.getSupportedBiometryType();return(t&&BIOMETRY_LABELS[t])??'biometric';}catch{return'biometric';}}
export async function isBiometricAvailable(){try{return (await Keychain.getSupportedBiometryType())!==null;}catch{return false;}}
export async function isBiometricUnlockEnabled(){try{return Boolean(await Keychain.hasGenericPassword({service:SERVICE}));}catch{return false;}}
export async function enableBiometricUnlock(password:string){await Keychain.setGenericPassword(USERNAME,password,{service:SERVICE,accessControl:Keychain.ACCESS_CONTROL.BIOMETRY_ANY_OR_DEVICE_PASSCODE,accessible:Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY});const check=await Keychain.getGenericPassword({service:SERVICE,authenticationPrompt:{title:'Enable Kivo unlock',subtitle:'Use your biometrics or device passcode',cancel:'Cancel'}});if(!check){await Keychain.resetGenericPassword({service:SERVICE});return false;}return true;}
export async function disableBiometricUnlock(){try{const c=await Keychain.getGenericPassword({service:SERVICE,authenticationPrompt:{title:'Disable Kivo biometric unlock',subtitle:'Authenticate to change wallet security',cancel:'Cancel'}});if(!c)return null;await Keychain.resetGenericPassword({service:SERVICE});return c.password;}catch{return null;}}
export async function getBiometricPassword(){try{const c=await Keychain.getGenericPassword({service:SERVICE,authenticationPrompt:{title:'Unlock Kivo',subtitle:'Use your biometrics to unlock your wallet',cancel:'Use password instead'}});return c?c.password:null;}catch{return null;}}
export async function clearBiometricUnlock(){await Keychain.resetGenericPassword({service:SERVICE}).catch(()=>{});}
