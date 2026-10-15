import assert from 'node:assert/strict';
import {applyJupiterFeeToSpendIntent, solanaAddressEquals, assertSolanaSystemTransfersWithinIntent, SOLANA_NATIVE_SPEND} from '../trading/core/solanaSpendGuard.ts';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const AGENCY = 'AgencyMintFixture';

const sellIntent = {
  spend: AGENCY,
  maxSpend: 151_556_749n,
  expectedOutputMint: USDC,
  expectedOutputMinimum: 252_644n,
};

const adjusted = applyJupiterFeeToSpendIntent(sellIntent, USDC, 13_300n, true, true);
assert.equal(adjusted.expectedOutputMinimum, 239_344n, 'sell minimum must be net of the included USDC fee');
assert.deepEqual(adjusted.extra, [{mint: USDC, units: 13_300n}], 'only the exact included fee is allowed as extra USDC spend');
assert.equal(sellIntent.expectedOutputMinimum, 252_644n, 'the helper must not mutate the original intent');

const skippedFee = applyJupiterFeeToSpendIntent(sellIntent, USDC, 0n, true, true);
assert.equal(skippedFee.expectedOutputMinimum, 252_644n);
assert.equal(skippedFee.extra, undefined, 'a skipped fee must not be allowed as extra spend');

const nonUsdcOutput = applyJupiterFeeToSpendIntent(
  {...sellIntent, expectedOutputMint: AGENCY},
  USDC,
  13_300n,
  true,
  false,
);
assert.equal(nonUsdcOutput.expectedOutputMinimum, 252_644n, 'non-USDC output minimum must not be reduced');
assert.deepEqual(nonUsdcOutput.extra, [{mint: USDC, units: 13_300n}]);

const feeBeforeSwap = applyJupiterFeeToSpendIntent(sellIntent, USDC, 13_300n, false, true);
assert.equal(feeBeforeSwap.expectedOutputMinimum, 252_644n, 'pre-swap fees must not reduce output minimum');

assert.throws(
  () => applyJupiterFeeToSpendIntent({...sellIntent, expectedOutputMinimum: 13_300n}, USDC, 13_300n, true, true),
  /greater than or equal to the quoted minimum sell output/,
  'a fee that consumes the full quoted minimum must be rejected',
);

// Solana addresses are case-sensitive Base58; altered casing must not match.
const canonicalMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
assert.equal(solanaAddressEquals(canonicalMint, canonicalMint), true);
assert.equal(solanaAddressEquals(canonicalMint, canonicalMint.toLowerCase()), false);
assert.equal(solanaAddressEquals(canonicalMint, canonicalMint.slice(0, -1) + (canonicalMint.endsWith('A') ? 'a' : 'A')), false);

// Token trades must not smuggle a direct SOL transfer inside the rent/fee allowance.
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const user = 'UserWalletBase58CaseSensitive111111111111';
const attacker = 'AttackerWalletBase58CaseSensitive1111111111';
const tokenSpend = {spend: canonicalMint, maxSpend: 100n};
function systemTransfer(amount) {
  const data = new Uint8Array(12);
  data[0] = 2; // SystemInstruction::Transfer (u32 little-endian)
  let remaining = BigInt(amount);
  for (let i = 0; i < 8; i++) { data[4 + i] = Number(remaining & 255n); remaining >>= 8n; }
  return data;
}
const legacyTransfer = amount => ({
  feePayer: user,
  instructions: [{programId: {toBase58: () => SYSTEM_PROGRAM}, keys: [
    {pubkey: {toBase58: () => user}, isSigner: true},
    {pubkey: {toBase58: () => attacker}, isSigner: false},
  ], data: systemTransfer(amount)}],
});
assert.throws(() => assertSolanaSystemTransfersWithinIntent(legacyTransfer(1n), user, tokenSpend), /extra SOL transfer/);
assert.doesNotThrow(() => assertSolanaSystemTransfersWithinIntent(legacyTransfer(100n), user, {spend: SOLANA_NATIVE_SPEND, maxSpend: 100n}));
assert.throws(() => assertSolanaSystemTransfersWithinIntent(legacyTransfer(101n), user, {spend: SOLANA_NATIVE_SPEND, maxSpend: 100n}), /more SOL than the amount/);
assert.doesNotThrow(() => assertSolanaSystemTransfersWithinIntent({
  message: {staticAccountKeys: [user, attacker, SYSTEM_PROGRAM], compiledInstructions: [{programIdIndex: 2, accountKeyIndexes: [0, 1], data: systemTransfer(1n)}]},
}, user, {spend: SOLANA_NATIVE_SPEND, maxSpend: 1n}));
assert.doesNotThrow(() => assertSolanaSystemTransfersWithinIntent(legacyTransfer(999n), attacker, tokenSpend));

console.log('Jupiter sell fee accounting and case-sensitive Solana address regression checks passed.');
