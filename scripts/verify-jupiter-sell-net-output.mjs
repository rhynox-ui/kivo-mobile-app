import assert from 'node:assert/strict';
import {applyJupiterFeeToSpendIntent} from '../trading/core/solanaSpendGuard.ts';

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

console.log('Jupiter sell fee accounting regression checks passed.');
