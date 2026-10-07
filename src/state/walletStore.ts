import * as Keychain from 'react-native-keychain';
import { english, generateMnemonic, mnemonicToAccount, type HDAccount } from 'viem/accounts';
import { createWalletClient, getAddress, type Hex } from 'viem';
import { transportFor, viemChainForChainId } from '@kivo/trading/core/chainRegistry';
import type { EvmCall, KivoEvmSigner } from '@kivo/trading/kivo/execute';

const SERVICE = 'com.kivo.chat.wallet';

export type WalletSession = {
  address: string;
  source: 'local' | 'external';
};

let session: WalletSession | null = null;
const listeners = new Set<(value: WalletSession | null) => void>();

function emit(){const value=session?{...session}:null;listeners.forEach(listener=>listener(value));}

export async function createLocalWallet(){
  const mnemonic=generateMnemonic(english,128);
  const account=mnemonicToAccount(mnemonic);
  await Keychain.setGenericPassword('kivo',mnemonic,{service:SERVICE});
  session={address:account.address,source:'local'};
  emit();
  return {mnemonic,address:account.address};
}

export async function importLocalWallet(mnemonic:string){
  const normalized=mnemonic.trim().replace(/\s+/g,' ');
  if(normalized.split(' ').length!==12&&normalized.split(' ').length!==24) throw new Error('Recovery phrase must contain 12 or 24 words.');
  const account=mnemonicToAccount(normalized);
  await Keychain.setGenericPassword('kivo',normalized,{service:SERVICE});
  session={address:account.address,source:'local'};
  emit();
  return {address:account.address};
}

export async function loadWalletSession(){
  const credentials=await Keychain.getGenericPassword({service:SERVICE});
  if(!credentials) return null;
  const account=mnemonicToAccount(credentials.password);
  session={address:account.address,source:'local'};
  emit();
  return getWalletSession();
}

export function getWalletSession(){return session?{...session}:null;}

export function subscribeToWallet(listener:(value:WalletSession|null)=>void){
  listeners.add(listener);listener(getWalletSession());return ()=>{listeners.delete(listener);};
}

export async function enableBiometricUnlock(){
  const credentials=await Keychain.getGenericPassword({service:SERVICE});
  if(!credentials) throw new Error('No local wallet is available on this device.');
  const supported=await Keychain.getSupportedBiometryType();
  if(!supported) throw new Error('This device does not report a supported biometric method.');
  await Keychain.setGenericPassword('kivo',credentials.password,{service:SERVICE,accessControl:Keychain.ACCESS_CONTROL.BIOMETRY_CURRENT_SET,accessible:Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,authenticationPrompt:'Authenticate to protect your Kivo wallet'});
  return supported;
}

export async function clearLocalWallet(){
  await Keychain.resetGenericPassword({service:SERVICE});
  session=null;emit();
}

export function isValidRecoveryWord(mnemonic:string,index:number,value:string){
  const words=mnemonic.trim().split(/\s+/);
  return words[index]?.toLowerCase()===value.trim().toLowerCase();
}

/** How this session can act: a device wallet can sign; an address-only connection is watch-only. */
export function walletKind(value: WalletSession | null): 'evm-local' | 'evm-watch' | null {
  if (!value) return null;
  return value.source === 'local' ? 'evm-local' : 'evm-watch';
}

/**
 * The device wallet as a Kivo execution signer.
 *
 * The recovery phrase is read from the keychain (which enforces biometric
 * unlock when enabled) only at the moment a trade is confirmed, turned
 * into a viem account inside this function, and never returned, logged
 * or stored anywhere else. Every transaction it signs has already passed
 * the shared intent firewall in /trading/kivo/execute.ts.
 */
export async function localEvmSigner(): Promise<KivoEvmSigner> {
  const current = getWalletSession();
  if (!current || current.source !== 'local') throw new Error('This wallet is watch-only on this device. Create or import a wallet to sign trades.');
  const credentials = await Keychain.getGenericPassword({ service: SERVICE, authenticationPrompt: { title: 'Confirm trade with Kivo' } });
  if (!credentials) throw new Error('The device wallet is locked or unavailable.');
  const account = mnemonicToAccount(credentials.password);
  if (account.address.toLowerCase() !== current.address.toLowerCase()) throw new Error('The unlocked wallet does not match the active session.');
  return {
    kind: 'evm-local',
    address: account.address,
    async ensureChain(chainId: number) {
      if (!viemChainForChainId(chainId)) throw new Error(`Kivo has no network configuration for chain ${chainId}.`);
    },
    async sendTransaction(call: EvmCall): Promise<Hex> {
      const chain = viemChainForChainId(call.chainId);
      if (!chain) throw new Error(`Kivo has no network configuration for chain ${call.chainId}.`);
      const client = createWalletClient({ account, chain, transport: transportFor(call.chainId) });
      return client.sendTransaction({ account, chain, to: call.to, data: call.data, value: call.value });
    },
  };
}

/**
 * Unlocks the device wallet (biometric prompt when enabled) for exactly one
 * gasless action: a trade or a USDC withdrawal. The account object holds
 * the key in memory only for the duration of `action`; nothing is returned,
 * logged or stored. Every trade it signs has passed the intent firewall in
 * /trading/kivo/execute.ts first.
 */
export async function withDeviceAccount<T>(title: string, action: (account: HDAccount) => Promise<T>): Promise<T> {
  const current = getWalletSession();
  if (!current || current.source !== 'local') throw new Error('Create or import a Kivo wallet on this device to trade.');
  const credentials = await Keychain.getGenericPassword({ service: SERVICE, authenticationPrompt: { title } });
  if (!credentials) throw new Error('The device wallet is locked or unavailable.');
  const account = mnemonicToAccount(credentials.password);
  if (account.address.toLowerCase() !== current.address.toLowerCase()) throw new Error('The unlocked wallet does not match the active session.');
  return action(account);
}

/**
 * Signs a plain-text message (Kivo social sign-in) with the device wallet.
 * Not a transaction; it cannot move funds. The phrase never leaves this function.
 */
export async function signMessageWithLocalWallet(message: string): Promise<string> {
  const current = getWalletSession();
  if (!current || current.source !== 'local') throw new Error('This wallet is watch-only on this device, so it cannot sign in to Kivo social.');
  const credentials = await Keychain.getGenericPassword({ service: SERVICE, authenticationPrompt: { title: 'Sign in to Kivo' } });
  if (!credentials) throw new Error('The device wallet is locked or unavailable.');
  const account = mnemonicToAccount(credentials.password);
  if (account.address.toLowerCase() !== current.address.toLowerCase()) throw new Error('The unlocked wallet does not match the active session.');
  return account.signMessage({ message });
}
