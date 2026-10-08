import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
let n = 0;
const check = (name, fn) => { fn(); n++; console.log('ok - ' + name); };

check('Mango fallback providers', () => {
  const s = read('trading/core/fallbackDex.ts');
  for (const p of ['uniswap-v4','uniswap-v3','sushiswap-v2','pancakeswap-v3','1inch','0x']) assert.ok(s.includes(p));
  assert.ok(s.includes('Promise.allSettled'));
});
check('Relay intent firewall', () => {
  assert.ok(read('trading/core/relayQuote.ts').includes('buildTransactionIntent'));
  assert.ok(read('trading/core/txIntentFirewall.ts').includes('assertQuoteSafeToSign'));
  assert.ok(read('trading/kivo/execute.ts').includes('assertQuoteSafeToSign'));
});
check('Solana security layers', () => {
  assert.ok(fs.existsSync(path.join(root,'trading/core/solanaSpendGuard.ts')));
  assert.ok(fs.existsSync(path.join(root,'trading/core/solanaTxIntent.ts')));
  assert.ok(read('trading/core/executeRelayQuote.ts').includes('solanaSpendIntentFor'));
});
check('EIP-7702 gasless execution', () => {
  assert.ok(read('trading/kivo/gasless.ts').match(/EIP-7702|Calibur/i));
  assert.ok(fs.existsSync(path.join(root,'trading/core/relayGaslessEvm.ts')));
});
check('Cached USDC balances', () => {
  const s = read('trading/kivo/balances.ts');
  assert.ok(s.includes('CACHE_TTL_MS'));
  assert.ok(s.includes('inFlight') || s.includes('cashInFlight'));
  assert.ok(s.includes('assetDecimalsForChain'));
});
check('Fee rate and cap', () => {
  const s = read('trading/core/fees.ts');
  assert.ok(s.includes('DEV_FEE_PCT = 0.005'));
  assert.ok(s.includes('DEV_FEE_MAX_USD = 50'));
});
check('Sensitive recovery inputs protected', () => {
  for (const p of ['src/screens/ImportWalletScreen.tsx','src/screens/VerifyRecoveryScreen.tsx','src/screens/ProfileSetupScreen.tsx']) {
    const s = read(p);
    assert.ok(s.includes('autoCorrect={false}'));
    assert.ok(s.includes('spellCheck={false}'));
    assert.ok(s.includes('autoComplete="off"'));
  }
});
check('No hard-coded Relay API key', () => {
  for (const p of ['trading/core/relayQuote.ts','trading/core/executeRelayQuote.ts','trading/kivo/gasless.ts','src/state/session.ts']) {
    assert.ok(!/RELAY_API_KEY\s*=\s*['"][^'"]+['"]/.test(read(p)));
  }
});
check('Critical trading files are typechecked', () => {
  assert.equal(Object.prototype.hasOwnProperty.call(JSON.parse(read('tsconfig.json')), 'exclude'), false);
});
console.log('\nMango parity gate: ' + n + ' checks passed');
