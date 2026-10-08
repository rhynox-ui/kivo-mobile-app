import * as Keychain from 'react-native-keychain';
import {encryptSecret,decryptSecret,type SecretRecord} from './walletCipher';import {checkPasswordPolicy} from './passwordPolicy';
import {getLockoutStatus,recordFailedAttempt,recordSuccessfulUnlock} from './unlockAttempts';
const SERVICE='com.kivo.chat.vault'; const USERNAME='kivo-vault';
const LEGACY_SERVICE='com.kivo.chat.wallet';
type StoredVault={version:number;mnemonicRecord:SecretRecord};
export class VaultLockedError extends Error{remainingMs:number;constructor(ms:number){super(`Too many incorrect attempts. Try again in ${Math.ceil(ms/1000)}s.`);this.remainingMs=ms;this.name='VaultLockedError';}}
export async function createVault(mnemonic:string,password:string){const policy=checkPasswordPolicy(password);if(!policy.ok)throw new Error('Password must be at least 14 characters and not be a common or predictable password.');const mnemonicRecord=await encryptSecret(mnemonic,password);await Keychain.setGenericPassword(USERNAME,JSON.stringify({version:1,mnemonicRecord}),{service:SERVICE,accessible:Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY});}
export async function loadVault():Promise<StoredVault|null>{try{const c=await Keychain.getGenericPassword({service:SERVICE});if(!c)return null;const v=JSON.parse(c.password);return v?.version===1&&v.mnemonicRecord?v:null;}catch{return null;}}
export async function hasVault(){return Boolean(await loadVault());}
export async function clearVault(){await Keychain.resetGenericPassword({service:SERVICE});}
export async function unlockVaultMnemonic(vault:StoredVault,password:string){const st=await getLockoutStatus();if(st.locked)throw new VaultLockedError(st.remainingMs);try{const mnemonic=await decryptSecret(vault.mnemonicRecord,password);await recordSuccessfulUnlock();return mnemonic;}catch(e){await recordFailedAttempt();throw e;}}

export async function getLegacyMnemonic():Promise<string|null>{try{const c=await Keychain.getGenericPassword({service:LEGACY_SERVICE});if(!c)return null;return c.password;}catch{return null;}}
export async function clearLegacyWallet(){await Keychain.resetGenericPassword({service:LEGACY_SERVICE}).catch(()=>{});}
