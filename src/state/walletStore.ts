import * as Keychain from 'react-native-keychain';
import { Platform } from 'react-native';
import bs58 from 'bs58';
import { english, generateMnemonic, mnemonicToAccount, type HDAccount } from 'viem/accounts';
import { bytesToHex, createWalletClient, getAddress, type Hex } from 'viem';
import { transportFor, viemChainForChainId } from '@kivo/trading/core/chainRegistry';
import type { EvmCall, KivoEvmSigner } from '@kivo/trading/kivo/execute';
import type { Keypair } from '@solana/web3.js';
import { deriveSolanaKeypair } from '../wallet/solanaKeys';
import { deriveNearAccount } from '@kivo/trading/wallet/keys';

const SERVICE = 'com.kivo.chat.wallet';
let cachedStorageOptions: Keychain.SetOptions | null = null;
let loadingWallet: Promise<WalletSession | null> | null = null;

async function walletStorageOptions() {
  if (cachedStorageOptions) return cachedStorageOptions;
  const options: Keychain.SetOptions = {
    service: SERVICE,
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  };
  // Android 23+ uses Android Keystore for react-native-keychain. Prefer
  // hardware-backed protection when the device actually exposes it, but do
  // not make wallet creation fail on devices that only provide secure software.
  if (Platform.OS === 'android') {
    try {
      const level = await Keychain.getSecurityLevel();
      options.securityLevel = level === Keychain.SECURITY_LEVEL.SECURE_HARDWARE
        ? Keychain.SECURITY_LEVEL.SECURE_HARDWARE
        : Keychain.SECURITY_LEVEL.SECURE_SOFTWARE;
    } catch {
      // Keep the platform's normal secure-storage default if the capability
      // query is unavailable on this device.
    }
  }
  cachedStorageOptions = options;
  return options;
}

export type WalletSession = {
  address: string;
  /** Same phrase, Solana path (Mango Pro's m/44'/501'/0'/0'). */
  solanaAddress?: string;
  nearAddress?: string;
  source: 'local' | 'external';
};

function solanaAddressFor(mnemonic: string): string | undefined {
  try { return deriveSolanaKeypair(mnemonic).publicKey.toBase58(); } catch { return undefined; }
}

function nearAddressFor(mnemonic: string): string | undefined {
  try { return deriveNearAccount(mnemonic).address; } catch { return undefined; }
}

let session: WalletSession | null = null;
const listeners = new Set<(value: WalletSession | null) => void>();

function emit(){const value=session?{...session}:null;listeners.forEach(listener=>listener(value));}

export async function createLocalWallet(){
  const mnemonic=generateMnemonic(english,128);
  const account=mnemonicToAccount(mnemonic);
  await Keychain.setGenericPassword('kivo',mnemonic,await walletStorageOptions());
  session={address:account.address,solanaAddress:solanaAddressFor(mnemonic),nearAddress:nearAddressFor(mnemonic),source:'local'};
  emit();
  return {mnemonic,address:account.address};
}

export async function importLocalWallet(mnemonic:string){
  const normalized=mnemonic.trim().replace(/\s+/g,' ');
  if(normalized.split(' ').length!==12&&normalized.split(' ').length!==24) throw new Error('Recovery phrase must contain 12 or 24 words.');
  const account=mnemonicToAccount(normalized);
  await Keychain.setGenericPassword('kivo',normalized,await walletStorageOptions());
  session={address:account.address,solanaAddress:solanaAddressFor(normalized),nearAddress:nearAddressFor(normalized),source:'local'};
  emit();
  return {address:account.address};
}

export async function loadWalletSession(){
  if (session) return getWalletSession();
  if (loadingWallet) return loadingWallet;
  loadingWallet = (async () => {
    const credentials=await Keychain.getGenericPassword({service:SERVICE});
    if(!credentials) return null;
    const account=mnemonicToAccount(credentials.password);
    // Derive Solana once per process. Mango Pro also derives account 0 only;
    // repeated screen mounts must not repeat HD derivation.
    session={address:account.address,solanaAddress:solanaAddressFor(credentials.password),nearAddress:nearAddressFor(credentials.password),source:'local'};
    emit();
    return getWalletSession();
  })();
  try { return await loadingWallet; } finally { loadingWallet = null; }
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
  await Keychain.setGenericPassword('kivo',credentials.password,{...(await walletStorageOptions()),accessControl:Keychain.ACCESS_CONTROL.BIOMETRY_CURRENT_SET,authenticationPrompt:'Authenticate to protect your Kivo wallet'});
  return supported;
}

export async function clearLocalWallet(){
  await Keychain.resetGenericPassword({service:SERVICE});
  const remaining=await Keychain.getGenericPassword({service:SERVICE});
  if (remaining) throw new Error('Kivo could not verify secure wallet deletion.');
  session=null;loadingWallet=null;emit();
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
 * Like withDeviceAccount, but also hands over the Solana keypair from the
 * same phrase, for routes with a Solana step (selling a Solana token). The
 * keypair exists only for the duration of `action`.
 */
export async function withDeviceAccounts<T>(title: string, action: (accounts: { evm: HDAccount; solana: Keypair; near: {address: string; privateKey: string}; relay: import('@kivo/trading/wallet/keys').DerivedAccounts }) => Promise<T>): Promise<T> {
  const current = getWalletSession();
  if (!current || current.source !== 'local') throw new Error('Create or import a Kivo wallet on this device to trade.');
  const credentials = await Keychain.getGenericPassword({ service: SERVICE, authenticationPrompt: { title } });
  if (!credentials) throw new Error('The device wallet is locked or unavailable.');
  const evm = mnemonicToAccount(credentials.password);
  if (evm.address.toLowerCase() !== current.address.toLowerCase()) throw new Error('The unlocked wallet does not match the active session.');
  const solana = deriveSolanaKeypair(credentials.password);
  const evmPrivateKey = evm.getHdKey().privateKey ? bytesToHex(evm.getHdKey().privateKey) : null;
  if (!evmPrivateKey) throw new Error('The device wallet key is unavailable.');
  const near = deriveNearAccount(credentials.password);
  const relay = {evm: {address: evm.address, privateKey: evmPrivateKey}, solana: {address: solana.publicKey.toBase58(), privateKey: bs58.encode(solana.secretKey)}, near};
  return action({evm, solana, near, relay});
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
