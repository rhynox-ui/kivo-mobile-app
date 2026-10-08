// Real on-chain balances for the connected wallet, read through the
// same public-RPC fallback transports the engine uses (core/chainRegistry).
// Nothing here is estimated: a chain that fails to answer is reported as
// an error row, never as a zero balance.

import {erc20Abi, formatUnits, getAddress, type Address} from 'viem';
import {MAINNET_CHAIN_IDS, TOKEN_ADDRESSES, assetDecimalsForChain, currencyAddress, type ChainKey} from '../core/chainData';
import {publicClientForChainId} from '../core/chainRegistry';
import {EVM_TRADE_CHAINS, USDC_CHAINS, nativeSymbol} from './tokens';

const EVM_CASH_CHAINS = EVM_TRADE_CHAINS;

/** USDC kept on Arc so the wallet can still pay the network gas after a trade. */
export const ARC_GAS_RESERVE_USDC = 0.01;

export function spendableCash(chainKey: ChainKey, balance: number): number {
  if (chainKey !== 'arc') return balance;
  return Math.max(0, balance - ARC_GAS_RESERVE_USDC);
}

const READ_TIMEOUT_MS = 8_000;
const CASH_CACHE_TTL_MS = 30_000;
let cashCache: {key: string; rows: CashBalanceRow[]; at: number} | null = null;
let cashInFlight: {key: string; promise: Promise<CashBalanceRow[]>} | null = null;

function withTimeout<T>(promise: Promise<T>, ms = READ_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Balance read timed out.')), ms);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}

export type TokenBalance = {chainKey: ChainKey; tokenAddress: string; symbol: string; raw: bigint; decimals: number; amount: number};

export type CashBalanceRow =
  | {chainKey: ChainKey; status: 'ok'; balance: TokenBalance}
  | {chainKey: ChainKey; status: 'error'; error: string};

const NATIVE_ADDRESSES = new Set(['0x0000000000000000000000000000000000000000', '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee']);

export function isNativeTokenAddress(address: string): boolean {
  return NATIVE_ADDRESSES.has(address.toLowerCase());
}

/** ERC-20 (or native) balance of `owner` on `chainKey`. Decimals come from the contract itself, never assumed. */
export async function readTokenBalance(chainKey: ChainKey, tokenAddress: string, owner: string, symbolHint?: string, decimalsHint?: number): Promise<TokenBalance> {
  const client = publicClientForChainId(MAINNET_CHAIN_IDS[chainKey]);
  const account = getAddress(owner) as Address;
  if (isNativeTokenAddress(tokenAddress)) {
    const raw = await withTimeout(client.getBalance({address: account}));
    return {chainKey, tokenAddress, symbol: nativeSymbol(chainKey), raw, decimals: 18, amount: Number(formatUnits(raw, 18))};
  }
  const token = getAddress(tokenAddress) as Address;
  const [raw, symbol] = await withTimeout(Promise.all([
    client.readContract({address: token, abi: erc20Abi, functionName: 'balanceOf', args: [account]}),
    symbolHint ? Promise.resolve(symbolHint) : client.readContract({address: token, abi: erc20Abi, functionName: 'symbol'}).catch(() => '?'),
  ]));
  const d = decimalsHint ?? 18;
  // ERC-20 decimals is a uint8, and real tokens use 0–36. A contract that
  // reports anything else is broken or hostile; formatting with it could
  // stall the app building a multi-million-digit string.
  if (!Number.isInteger(d) || d < 0 || d > 36) throw new Error('This token reports invalid decimals, so Kivo cannot read its balance safely.');
  return {chainKey, tokenAddress, symbol: String(symbol), raw, decimals: d, amount: Number(formatUnits(raw, d))};
}

export async function readNativeBalance(chainKey: ChainKey, owner: string): Promise<TokenBalance> {
  return readTokenBalance(chainKey, '0x0000000000000000000000000000000000000000', owner);
}

/** USDC on one chain, with the chain's real on-chain decimals (BNB Chain USDC is 18, not 6). */
export function cashAssetSymbol(chainKey: ChainKey): 'USDC' | 'USDG' { return chainKey === 'robinhood' ? 'USDG' : 'USDC'; }

export function cashAssetAddress(chainKey: ChainKey): string { const symbol = cashAssetSymbol(chainKey); const address = TOKEN_ADDRESSES[symbol]?.[chainKey]; if (!address) throw new Error(`No verified ${symbol} contract on ${chainKey}.`); return address; }

export async function readUsdcBalance(chainKey: ChainKey, owner: string): Promise<TokenBalance> {
  const cashSymbol = cashAssetSymbol(chainKey);
  const address = cashAssetAddress(chainKey);
  // Mango Pro keeps verified token decimals in chainData. Do the same here:
  // a USDC balance screen should not make a second RPC call per chain just to
  // read a static contract property.
  const decimals = assetDecimalsForChain(chainKey, cashSymbol) ?? 6;
  return readTokenBalance(chainKey, address, owner, cashSymbol, decimals);
}
export async function readSolanaNativeBalance(owner: string): Promise<TokenBalance> {
  const [{Connection, PublicKey}] = await Promise.all([import('@solana/web3.js')]);
  const connection = new Connection('https://solana-rpc.publicnode.com', 'confirmed');
  const raw = await connection.getBalance(new PublicKey(owner));
  return {chainKey: 'solana', tokenAddress: '11111111111111111111111111111111', symbol: 'SOL', raw: BigInt(raw), decimals: 9, amount: Number(formatUnits(BigInt(raw), 9))};
}

export async function readSolanaTokenBalance(mintAddress: string, owner: string, symbolHint?: string): Promise<TokenBalance> {
  const [{Connection, PublicKey}] = await Promise.all([import('@solana/web3.js')]);
  const connection = new Connection('https://solana-rpc.publicnode.com', 'confirmed');
  const ownerKey = new PublicKey(owner);
  const mint = new PublicKey(mintAddress);
  const accounts = await connection.getParsedTokenAccountsByOwner(ownerKey, {mint});
  let raw = 0n;
  let decimals = 6;
  for (const account of accounts.value) {
    const info = account.account.data.parsed?.info;
    const tokenAmount = info?.tokenAmount;
    if (!tokenAmount) continue;
    raw += BigInt(tokenAmount.amount ?? '0');
    decimals = Number(tokenAmount.decimals ?? decimals);
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error('This Solana token reports invalid decimals.');
  return {chainKey: 'solana', tokenAddress: mintAddress, symbol: symbolHint ?? '?', raw, decimals, amount: Number(formatUnits(raw, decimals))};
}
export async function readSolanaUsdcBalance(owner: string): Promise<TokenBalance> {
  const mintAddress = TOKEN_ADDRESSES.USDC?.solana;
  if (!mintAddress) throw new Error('No verified USDC mint on Solana.');
  const [{Connection, PublicKey}, splToken] = await Promise.all([
    import('@solana/web3.js'),
    import('@solana/spl-token'),
  ]);
  const connection = new Connection('https://solana-rpc.publicnode.com', 'confirmed');
  const ownerKey = new PublicKey(owner);
  const mint = new PublicKey(mintAddress);
  const ata = await splToken.getAssociatedTokenAddress(mint, ownerKey);
  const info = await connection.getTokenAccountBalance(ata).catch(() => null);
  const amount = info ? Number(info.value.uiAmountString ?? info.value.uiAmount ?? 0) : 0;
  const raw = BigInt(info?.value.amount ?? '0');
  return {chainKey: 'solana', tokenAddress: mintAddress, symbol: 'USDC', raw, decimals: 6, amount};
}

/** USDC across every chain Kivo can pay from. Each chain fails independently. */
export async function fetchCashBalances(owner: string, chains: ChainKey[] = USDC_CHAINS, solanaOwner: string = owner): Promise<CashBalanceRow[]> {
  const key = owner.toLowerCase() + ':' + chains.join(',');
  if (cashCache && cashCache.key === key && Date.now() - cashCache.at < CASH_CACHE_TTL_MS) return cashCache.rows;
  if (cashInFlight?.key === key) return cashInFlight.promise;
  const promise = (async () => {
    const settled = await Promise.allSettled(chains.map(chainKey => chainKey === 'solana' ? readSolanaUsdcBalance(solanaOwner) : readUsdcBalance(chainKey, owner)));
    const rows = settled.map((outcome, index): CashBalanceRow => {
      const chainKey = chains[index];
      return outcome.status === 'fulfilled'
        ? {chainKey, status: 'ok', balance: outcome.value}
        : {chainKey, status: 'error', error: outcome.reason instanceof Error ? outcome.reason.message : 'Balance unavailable.'};
    });
    cashCache = {key, rows, at: Date.now()};
    return rows;
  })();
  cashInFlight = {key, promise};
  try { return await promise; }
  finally { if (cashInFlight?.promise === promise) cashInFlight = null; }
}

export function clearCashBalanceCache(): void {
  cashCache = null;
}

export function totalCashUsd(rows: CashBalanceRow[]): {total: number; complete: boolean} {
  let total = 0;
  let complete = true;
  for (const row of rows) {
    if (row.status === 'ok') total += row.balance.amount;
    else complete = false;
  }
  return {total, complete};
}

/** Best chain to pay from: prefer the token's own chain when it holds enough, else the largest USDC balance. */
export function pickPayChain(rows: CashBalanceRow[], tokenChain: ChainKey, amountUsd: number | null): ChainKey | null {
  const ok = rows.filter((row): row is Extract<CashBalanceRow, {status: 'ok'}> => row.status === 'ok' && row.balance.amount > 0);
  const sameChain = ok.find(row => row.chainKey === tokenChain);
  if (sameChain && (amountUsd == null || sameChain.balance.amount >= amountUsd)) return tokenChain;
  const sorted = [...ok].sort((a, b) => b.balance.amount - a.balance.amount);
  return sorted[0]?.chainKey ?? (USDC_CHAINS.includes(tokenChain) ? tokenChain : null);
}

export function usdcDecimals(chainKey: ChainKey): number {
  return assetDecimalsForChain(chainKey, 'USDC') ?? 6;
}

export type PayBalanceRow = {
  asset: {chainKey: ChainKey; address: string; symbol: string; decimals: number};
  status: 'ok' | 'error';
  balance?: TokenBalance;
  error?: string;
};

/** Verified native + registry token balances allowed by the web trade ticket. */
export async function fetchPayBalances(owner: string, chains: ChainKey[] = EVM_CASH_CHAINS): Promise<PayBalanceRow[]> {
  const assets: Array<{chainKey: ChainKey; address: string; symbol: string; decimals: number}> = [];
  for (const chainKey of chains) {
    assets.push({chainKey, address: currencyAddress(chainKey, nativeSymbol(chainKey)), symbol: nativeSymbol(chainKey), decimals: assetDecimalsForChain(chainKey, nativeSymbol(chainKey)) ?? 18});
    for (const symbol of VERIFIED_PAY_ASSETS) {
      const address = TOKEN_ADDRESSES[symbol]?.[chainKey];
      if (!address) continue;
      assets.push({chainKey, address, symbol, decimals: assetDecimalsForChain(chainKey, symbol) ?? 18});
    }
  }
  const settled = await Promise.allSettled(assets.map(asset => readTokenBalance(asset.chainKey, asset.address, owner, asset.symbol)));
  return settled.map((outcome, index) => outcome.status === 'fulfilled'
    ? {asset: assets[index], status: 'ok', balance: outcome.value}
    : {asset: assets[index], status: 'error', error: outcome.reason instanceof Error ? outcome.reason.message : 'Balance unavailable.'});
}

export const VERIFIED_PAY_ASSETS = ['USDC', 'USDT', 'WBTC', 'USDT0', 'USDG'] as const;