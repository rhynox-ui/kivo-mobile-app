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
check('Solana device execution path', () => {
  const trade = read('src/screens/TradeScreen.tsx');
  assert.ok(trade.includes('executeRelayQuote'));
  assert.ok(trade.includes('withDeviceAccounts'));
  assert.ok(read('trading/kivo/quote.ts').includes('Mobile signs Relay Solana instruction bundles'));
  assert.ok(read('trading/core/executeRelayQuote.ts').includes('signAndSendRelaySolanaStep'));
});
check('NEAR wallet derivation contract', () => {
  const s = read('trading/wallet/keys.ts');
  assert.ok(s.includes("m/44'/397'/0'"));
  assert.ok(s.includes('near?: ChainAccount'));
});
check('NEAR execution and 1Click', () => {
  for (const p of [
    'trading/core/nearTrade.ts','trading/core/nearSigning.ts','trading/core/nearRpc.ts',
    'trading/core/nearOutcome.ts','trading/core/intearRouter.ts','trading/core/oneClick.ts',
    'trading/core/oneClickDeposits.ts','trading/core/nearCashMoves.ts','trading/wallet/oneClickSwapStore.ts'
  ]) assert.ok(fs.existsSync(path.join(root,p)), p);
  assert.equal(read('trading/core/chainData.ts').includes('NEAR_ENABLED = true'), true);
  assert.ok(read('trading/kivo/tokens.ts').includes("chainKey: 'near'"));
  assert.ok(read('src/screens/NearTradePanel.tsx').includes('executeNearTrade'));
});
check('GoPlus token security', () => {
  const s = read('trading/core/goplusTokenSecurity.ts');
  assert.ok(s.includes('api.gopluslabs.io'));
  assert.ok(s.includes('checkTokenSecurity'));
  assert.ok(s.includes('checkSolanaTokenSecurity'));
});
check('Crash diagnostics', () => {
  const s = read('src/debug/crashReporter.tsx');
  assert.ok(s.includes('installCrashReporter'));
  assert.ok(s.includes('CrashBoundary'));
  assert.ok(read('App.tsx').includes('installCrashReporter()'));
  assert.ok(read('App.tsx').includes('<CrashBoundary>'));
});
check('Android build CI', () => {
  const s = read('.github/workflows/android-build-check.yml');
  assert.ok(s.includes('assembleDebug'));
  assert.ok(s.includes('upload-artifact'));
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
check('Recovery phrase whitespace parsing', () => {
  const s = read('src/wallet/recoveryPhrase.ts');
  assert.ok(s.includes(String.raw`replace(/\s+/g, ' ')`));
  assert.ok(s.includes(String.raw`split(/\s+/)`));
  assert.ok(!s.includes(String.raw`replace(/\\s+/g`));
  assert.ok(!s.includes(String.raw`split(/\\s+/)`));
  assert.ok(read('src/state/walletStore.ts').includes('normalizeRecoveryPhrase(mnemonic)'));
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
check('Mango deposit UI parity', () => {
  const s = read('src/screens/WalletSummaryScreen.tsx');
  assert.ok(s.includes("'near'"));
  assert.ok(s.includes('react-native-qrcode-svg'));
  assert.ok(read('src/wallet/NetworkIcon.tsx').includes("chainKey === 'near'"));
});
check('Mango Convert execution parity', () => {
  const s = read('src/components/ConvertCashSheet.tsx');
  assert.ok(s.includes('executeRelayQuote'));
  assert.ok(s.includes('useGaslessTrading:true'));
  assert.ok(s.includes('recordTrade'));
  assert.ok(s.includes('NetworkIcon'));
  // Arc's gas reserve is kept by the shared spendableCash() (trading/core/usdcBalances.ts).
  assert.ok(s.includes('spendableCash('));
  assert.ok(read('trading/core/usdcBalances.ts').includes('ARC_GAS_RESERVE_USDC'));
});
check('Critical trading files are typechecked', () => {
  assert.equal(Object.prototype.hasOwnProperty.call(JSON.parse(read('tsconfig.json')), 'exclude'), false);
});
check('Wallet removal locks signing before secret cleanup', () => {
  const s = read('src/state/walletStore.ts');
  const start = s.indexOf('export async function clearLocalWallet');
  const end = s.indexOf('\n}', start);
  assert.ok(start >= 0 && end > start);
  const body = s.slice(start, end);
  assert.ok(body.indexOf('session=null;unlockedMnemonic=null;emit();') < body.indexOf('await clearBiometricUnlock()'));
  assert.ok(body.indexOf('await clearBiometricUnlock()') < body.indexOf('await clearVault()'));
});
check('Wallet switch invalidates stale API session immediately', () => {
  const s = read('src/state/session.ts');
  const start = s.indexOf('subscribeToWallet(wallet =>');
  const end = s.indexOf('walletActivationQueue = walletActivationQueue.then', start);
  assert.ok(start >= 0 && end > start);
  assert.ok(s.slice(start, end).includes('void api.restore(address).catch(() => {});'));
  assert.ok(s.slice(start, end).includes('stopChatSync();'));
});
console.log('\nMango parity gate: ' + n + ' checks passed');
check('Solana spend guard enforces the reviewed output minimum', () => {
  const s = read('trading/core/solanaSpendGuard.ts');
  const start = s.indexOf('export async function assertSolanaSpendWithinIntentWeb3');
  const body = s.slice(start, s.indexOf('\n}', start));
  assert.ok(body.includes('expectedOutputMint: intent.expectedOutputMint'));
  assert.ok(body.includes('expectedOutputMinimum: intent.expectedOutputMinimum'));
});
check('EVM firewall refuses allowance grants and native value on token trades', () => {
  const s = read('trading/core/txIntentFirewall.ts');
  assert.ok(s.includes("'0x39509351'") && s.includes("'0xa22cb465'"));
  assert.ok(!s.includes('which is usually a protocol fee but is worth knowing about'));
});
check('Kivo messages are checked before the device wallet signs them', () => {
  assert.ok(read('src/state/session.ts').includes("signKivoMessage(message, 'sign-in')"));
  assert.ok(read('src/screens/EditProfileScreen.tsx').includes("signKivoMessage(approval.message, 'profile')"));
});
check('Recovery phrase and private keys render inside FLAG_SECURE-protected screens', () => {
  for (const f of ['src/wallet/RevealPhraseModal.tsx', 'src/wallet/ExportPrivateKeyModal.tsx']) {
    const s = read(f);
    assert.ok(!/import\s*\{[^}]*\bModal\b[^}]*\}\s*from\s*'react-native'/.test(s) && s.includes('setScreenSecure(true)'));
  }
  assert.ok(read('src/screens/RecoveryBackupScreen.tsx').includes('setScreenSecure(true)'));
});
check('Blue Star rules come from the server at start-up (no app update for rule changes)', () => {
  const t = read('shared/api/types.ts');
  assert.ok(t.includes('export function applyClientLimits') && t.includes('liveLimits.messageChars'));
  assert.ok(read('src/state/session.ts').includes('applyClientLimits('));
  assert.ok(read('shared/api/client.ts').includes("'/api/limits'"));
});
