// Mango Pro signs Google-login (Particle) wallets here. Kivo wallets are
// recovery-phrase wallets only, so these paths are never taken.
const NOT_SUPPORTED = 'Google sign-in wallets are not supported in Kivo. Use a recovery-phrase wallet.';
export async function signSolanaTransactionViaParticle(_serialized: Uint8Array): Promise<Uint8Array> { throw new Error(NOT_SUPPORTED); }
export async function signAndSendSolanaTransactionViaParticle(_serialized: Uint8Array): Promise<string> { throw new Error(NOT_SUPPORTED); }
