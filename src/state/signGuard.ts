// Signs Kivo's own sign-in / profile-approval messages after checking them (see signGuardRules.ts).
import {getWalletSession, signMessageWithLocalWallet} from './walletStore';
import {assertKivoMessage, type KivoSignKind} from './signGuardRules';

/** Signs a Kivo sign-in or profile-approval message with the device wallet, after checking it. */
export async function signKivoMessage(message: string, kind: KivoSignKind): Promise<string> {
  const wallet = getWalletSession();
  if (!wallet) throw new Error('No wallet is unlocked.');
  assertKivoMessage(message, kind, wallet.address);
  return signMessageWithLocalWallet(message);
}
