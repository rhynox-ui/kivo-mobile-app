import type {RelayQuote} from './relayQuote.ts';
import type {TransactionIntent} from './txIntentFirewall.ts';
import type {SolanaSpendIntent} from './solanaSpendGuard.ts';

const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * Build the exact token-account checks for a Solana destination before signing.
 * Unsupported or incomplete output metadata fails closed instead of silently
 * dropping the expected-output check.
 */
export async function solanaOutputVerificationFor(
  quote: RelayQuote,
  intent: TransactionIntent,
  ownerAddress: string,
): Promise<Pick<SolanaSpendIntent, 'expectedOutputMint' | 'expectedOutputMinimum' | 'expectedOutputAccounts'>> {
  if (intent.destinationChainId !== 792703809) return {};
  const output = quote.details?.currencyOut;
  const mint = output?.currency?.address;
  const minimumAmount = output?.minimumAmount;
  if (typeof mint !== 'string' || mint.length === 0 || typeof minimumAmount !== 'string' || !/^\\d+$/.test(minimumAmount) || BigInt(minimumAmount) <= 0n) {
    throw new Error('The Solana quote omitted its expected output token or minimum receive amount — refusing to sign this trade.');
  }
  // Native SOL/WSOL can be unwrapped or closed during route cleanup. Until
  // the spend guard can prove the minimum SOL delta independently, block
  // these outputs rather than silently omitting the output check.
  if (mint === SYSTEM_PROGRAM_ID || mint === WRAPPED_SOL_MINT) {
    throw new Error('Native SOL output cannot be verified safely on this route yet — refusing to sign this trade.');
  }
  try {
    const [{PublicKey}, splToken] = await Promise.all([import('@solana/web3.js'), import('@solana/spl-token')]);
    const owner = new PublicKey(ownerAddress);
    const mintKey = new PublicKey(mint);
    const accounts = await Promise.all([
      splToken.getAssociatedTokenAddress(mintKey, owner, false, splToken.TOKEN_PROGRAM_ID, splToken.ASSOCIATED_TOKEN_PROGRAM_ID),
      splToken.getAssociatedTokenAddress(mintKey, owner, false, splToken.TOKEN_2022_PROGRAM_ID, splToken.ASSOCIATED_TOKEN_PROGRAM_ID),
    ]);
    return {expectedOutputMint: mint, expectedOutputMinimum: BigInt(minimumAmount), expectedOutputAccounts: accounts.map(a => a.toBase58())};
  } catch {
    throw new Error('The Solana output could not be verified safely — refusing to sign this trade.');
  }
}
