import { mnemonicToAccount, type HDAccount } from 'viem/accounts';
import { validateMnemonic } from '@scure/bip39';
import { wordlist as english } from '@scure/bip39/wordlists/english.js';
import { createWalletClient, bytesToHex, type Hex } from 'viem';
import type { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { transportFor, viemChainForChainId } from '@kivo/trading/core/chainRegistry';
import type { EvmCall, KivoEvmSigner } from '@kivo/trading/kivo/execute';
import { deriveSolanaKeypair } from '../wallet/solanaKeys';
import { normalizeRecoveryPhrase, recoveryWordMatches } from '../wallet/recoveryPhrase';
import { deriveNearAccount } from '@kivo/trading/wallet/keys';
import { clearBiometricUnlock, disableBiometricUnlock as disableProtectedBiometricUnlock, enableBiometricUnlock as enableProtectedBiometricUnlock, getBiometricPassword, getBiometryLabel, isBiometricUnlockEnabled } from '../wallet/biometricAuth';
import { createVault, clearVault, loadVault, unlockVaultMnemonic } from '../wallet/vault';

export type WalletSession={address:string;solanaAddress?:string;nearAddress?:string;source:'local'|'external'};
let session:WalletSession|null=null;let unlockedMnemonic:string|null=null;
const listeners=new Set<(v:WalletSession|null)=>void>();
function emit(){const v=session?{...session}:null;listeners.forEach(l=>l(v));}
function solanaAddressFor(m:string){try{return deriveSolanaKeypair(m).publicKey.toBase58();}catch{return undefined;}}
function nearAddressFor(m:string){try{return deriveNearAccount(m).address;}catch{return undefined;}}
function setUnlocked(mnemonic:string){const a=mnemonicToAccount(mnemonic);unlockedMnemonic=mnemonic;session={address:a.address,solanaAddress:solanaAddressFor(mnemonic),nearAddress:nearAddressFor(mnemonic),source:'local'};emit();return session;}
export async function createLocalWallet(mnemonic:string,password:string){await createVault(mnemonic,password);return setUnlocked(mnemonic);}
export async function importLocalWallet(mnemonic:string,password:string){const normalized=normalizeRecoveryPhrase(mnemonic);if(!validateMnemonic(normalized,english))throw new Error('Recovery phrase is invalid. Check the words and order.');mnemonicToAccount(normalized);await createVault(normalized,password);setUnlocked(normalized);return{address:session!.address};}
export async function loadWalletSession(){return getWalletSession();}
export function getWalletSession(){return session?{...session}:null;}
export function lockWalletSession(){session=null;unlockedMnemonic=null;emit();}
export function subscribeToWallet(l:(v:WalletSession|null)=>void){listeners.add(l);l(getWalletSession());return()=>{listeners.delete(l);};}
export async function unlockWalletWithPassword(password:string){const vault=await loadVault();if(!vault)throw new Error('No local wallet is available on this device.');return setUnlocked(await unlockVaultMnemonic(vault,password));}
export async function enableBiometricUnlockWithPassword(password:string){const vault=await loadVault();if(!vault)throw new Error('No local wallet is available on this device.');await unlockVaultMnemonic(vault,password);const ok=await enableProtectedBiometricUnlock(password);if(!ok)throw new Error('Unable to enable biometric wallet unlock.');if(!unlockedMnemonic)setUnlocked(await unlockVaultMnemonic(vault,password));return getBiometryLabel();}
export async function disableBiometricUnlock(){const password=await disableProtectedBiometricUnlock();if(!password)return false;const vault=await loadVault();if(!vault)return false;setUnlocked(await unlockVaultMnemonic(vault,password));return true;}
export async function unlockWalletWithBiometric(){const password=await getBiometricPassword();if(!password)throw new Error('Wallet unlock was cancelled or failed.');const vault=await loadVault();if(!vault)throw new Error('No local wallet is available on this device.');return setUnlocked(await unlockVaultMnemonic(vault,password));}
export async function clearLocalWallet(){
  // Lock in-memory signing immediately; secure-storage cleanup may be slow or fail.
  session=null;unlockedMnemonic=null;emit();
  await clearBiometricUnlock();
  await clearVault();
}
async function getSigningMnemonic(title:string){if(unlockedMnemonic)return unlockedMnemonic;if(await isBiometricUnlockEnabled()){const p=await getBiometricPassword();if(!p)return null;const v=await loadVault();return v?await unlockVaultMnemonic(v,p):null;}return null;}
export async function localEvmSigner():Promise<KivoEvmSigner>{const current=getWalletSession();if(!current||current.source!=='local')throw new Error('Create or import a Kivo wallet on this device to sign trades.');const mnemonic=await getSigningMnemonic('Confirm trade with Kivo');if(!mnemonic)throw new Error('The device wallet is locked or unavailable.');const account=mnemonicToAccount(mnemonic);if(account.address.toLowerCase()!==current.address.toLowerCase())throw new Error('The unlocked wallet does not match the active session.');return{kind:'evm-local',address:account.address,async ensureChain(chainId:number){if(!viemChainForChainId(chainId))throw new Error(`Kivo has no network configuration for chain ${chainId}.`);},async sendTransaction(call:EvmCall):Promise<Hex>{const chain=viemChainForChainId(call.chainId);if(!chain)throw new Error(`Kivo has no network configuration for chain ${call.chainId}.`);const client=createWalletClient({account,chain,transport:transportFor(call.chainId)});return client.sendTransaction({account,chain,to:call.to,data:call.data,value:call.value});}};}
export async function withDeviceAccount<T>(title:string,action:(account:HDAccount)=>Promise<T>):Promise<T>{const current=getWalletSession();if(!current||current.source!=='local')throw new Error('Create or import a Kivo wallet on this device to trade.');const m=await getSigningMnemonic(title);if(!m)throw new Error('The device wallet is locked or unavailable.');const account=mnemonicToAccount(m);if(account.address.toLowerCase()!==current.address.toLowerCase())throw new Error('The unlocked wallet does not match the active session.');return action(account);}
export async function withDeviceAccounts<T>(title:string,action:(accounts:{evm:HDAccount;solana:Keypair;near:{address:string;privateKey:string};relay:import('@kivo/trading/wallet/keys').DerivedAccounts})=>Promise<T>):Promise<T>{const current=getWalletSession();if(!current||current.source!=='local')throw new Error('Create or import a Kivo wallet on this device to trade.');const m=await getSigningMnemonic(title);if(!m)throw new Error('The device wallet is locked or unavailable.');const evm=mnemonicToAccount(m);if(evm.address.toLowerCase()!==current.address.toLowerCase())throw new Error('The unlocked wallet does not match the active session.');const solana=deriveSolanaKeypair(m);const pk=evm.getHdKey().privateKey;if(!pk)throw new Error('The device wallet key is unavailable.');const evmPrivateKey=bytesToHex(new Uint8Array(pk));const near=deriveNearAccount(m);const relay={evm:{address:evm.address,privateKey:evmPrivateKey},solana:{address:solana.publicKey.toBase58(),privateKey:bs58.encode(solana.secretKey)},near};return action({evm,solana,near,relay});}
export async function signMessageWithLocalWallet(message:string){const current=getWalletSession();if(!current||current.source!=='local')throw new Error('This wallet is watch-only on this device.');const m=await getSigningMnemonic('Sign in to Kivo');if(!m)throw new Error('The device wallet is locked or unavailable.');const account=mnemonicToAccount(m);if(account.address.toLowerCase()!==current.address.toLowerCase())throw new Error('The unlocked wallet does not match the active session.');return account.signMessage({message});}
export function isValidRecoveryWord(mnemonic:string,index:number,value:string){return recoveryWordMatches(mnemonic,index,value);}
export function walletKind(v:WalletSession|null):'evm-local'|'evm-watch'|null{return v?v.source==='local'?'evm-local':'evm-watch':null;}
