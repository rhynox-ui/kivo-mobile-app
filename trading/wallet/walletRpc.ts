// src/wallet/walletRpc.ts
//
// Scoped port of mango-mobile's own src/wallet/walletRpc.js — started
// as exactly what a USDC balance read per chain needed (an EVM ERC-20
// balanceOf and a Solana SPL token balance), now also carrying the
// on-chain token-metadata lookup TokenTradeScreen.tsx's Sell side needs
// (a searched token's real decimals — DexScreener's search response
// doesn't carry them, so converting a typed "sell N tokens" amount into
// base units needs a live decimals() read). Not ported: mobile's
// native-balance reads and the same-chain multicall batching (that
// optimization pays off when several DIFFERENT tokens on the SAME chain
// are read together — this app never reads more than one token per
// chain in a single screen, so batching would have nothing to batch).
//
// A 45s balance cache mirrors mobile's own — a USDC balance doesn't move
// minute-to-minute for most users, and re-fetching on every render would
// just be redundant RPC load for the same answer. Token metadata
// (symbol/decimals) gets its own cache-forever policy below instead —
// those are fixed the moment a contract/mint is created and can never
// change afterward, so there's no TTL to expire.

import {createPublicClient} from 'viem';
import {getViemChain, transportFor} from '../core/chainRegistry.ts';
import type {ChainKey} from '../core/chainData';

// Lazy, not a top-level import — same reason mango-mobile's own
// walletRpc.js's getAsyncStorage() helper exists: a static import of a
// native module at module-load time breaks anything that imports this
// file (this app's own verify-*.mjs offline scripts included) outside a
// real RN runtime. Resolved once, cached, and never thrown past —
// storage simply being unavailable should never break a balance/
// decimals read that doesn't otherwise need it.
let asyncStoragePromise: Promise<typeof import('@react-native-async-storage/async-storage').default | null> | null = null;
function getAsyncStorage() {
  if (!asyncStoragePromise) {
    asyncStoragePromise = import('@react-native-async-storage/async-storage')
      .then(mod => mod.default)
      .catch(() => null);
  }
  return asyncStoragePromise;
}

// Real bug this closes, confirmed live: "Couldn't load balance" firing
// even for plain native SOL, on an otherwise-healthy connection — with
// only two endpoints, a single bad moment for either one (the Solana
// Foundation's own public endpoint is documented as heavily rate-limited
// and not meant for production traffic; solanatracker's is a smaller
// third-party service with no uptime guarantee) means every call in the
// loop below fails together. Two more genuinely public, keyless RPC
// providers added as further fallbacks — Ankr's and PublicNode's public
// Solana endpoints, both real infra providers already relied on
// elsewhere in the RPC-aggregator ecosystem, not first-party but not a
// fly-by-night host either.
const MANGO_HELIUS_RPC_URL = 'https://mangoprotocol.site/api/v1/pro/helius-rpc';

async function heliusRpc<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch(MANGO_HELIUS_RPC_URL, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({jsonrpc: '2.0', id: Date.now(), method, params}),
  });
  if (!response.ok) throw new Error('Mango Helius proxy unavailable');
  const payload = await response.json() as {result?: T; error?: {message?: string}};
  if (payload.error) throw new Error(payload.error.message ?? 'Helius RPC error');
  if (payload.result === undefined) throw new Error('Helius RPC returned no result');
  return payload.result;
}

const SOLANA_RPC_ENDPOINTS = [
  'https://rpc.solanatracker.io/public',
  'https://solana-rpc.publicnode.com',
  'https://rpc.ankr.com/solana',
  'https://api.mainnet-beta.solana.com',
];

const ERC20_BALANCE_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    inputs: [{name: 'account', type: 'address'}],
    outputs: [{type: 'uint256'}],
    stateMutability: 'view',
  },
] as const;

const clientCache = new Map<ChainKey, ReturnType<typeof createPublicClient>>();

function getWalletPublicClient(chainKey: ChainKey) {
  const cached = clientCache.get(chainKey);
  if (cached) return cached;
  const chain = getViemChain(chainKey);
  const client = createPublicClient({chain, transport: transportFor(chain.id)});
  clientCache.set(chainKey, client);
  return client;
}

const BALANCE_CACHE_TTL_MS = 45_000;
const balanceCache = new Map<string, {data: number; fetchedAt: number}>();
function getCached(key: string): number | null {
  const entry = balanceCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt >= BALANCE_CACHE_TTL_MS) return null;
  return entry.data;
}
function setCached(key: string, data: number): void {
  balanceCache.set(key, {data, fetchedAt: Date.now()});
}

/** Real native-asset (ETH/BNB/POL/etc.) balance for an EVM chain — added alongside fetchWalletTokenBalance once TokenTradeScreen's Buy side needed a real "how much can I spend" answer instead of leaving the quick-percent row permanently disabled. */
export async function fetchWalletNativeBalance(chainKey: ChainKey, address: string, {forceFresh = false}: {forceFresh?: boolean} = {}): Promise<number> {
  const key = `evm-native:${chainKey}:${address.toLowerCase()}`;
  if (!forceFresh) {
    const cached = getCached(key);
    if (cached !== null) return cached;
  }
  const client = getWalletPublicClient(chainKey);
  const wei = await client.getBalance({address: address as `0x${string}`});
  const balance = Number(wei) / 1e18;
  setCached(key, balance);
  return balance;
}

export async function fetchWalletTokenBalance(chainKey: ChainKey, tokenAddress: string, decimals: number, address: string, {forceFresh = false}: {forceFresh?: boolean} = {}): Promise<number> {
  const key = `evm-token:${chainKey}:${tokenAddress.toLowerCase()}:${address.toLowerCase()}`;
  if (!forceFresh) {
    const cached = getCached(key);
    if (cached !== null) return cached;
  }
  const client = getWalletPublicClient(chainKey);
  const raw = await client.readContract({
    address: tokenAddress as `0x${string}`,
    abi: ERC20_BALANCE_ABI,
    functionName: 'balanceOf',
    args: [address as `0x${string}`],
  });
  const balance = Number(raw) / 10 ** decimals;
  setCached(key, balance);
  return balance;
}

/**
 * Zero is a real, common answer — a wallet that's never held this token
 * has no associated token account (ATA) at all, treated as balance 0,
 * not an error. Tries both the legacy TOKEN_PROGRAM_ID and
 * TOKEN_2022_PROGRAM_ID (same real bug fix mobile's own walletRpc.js
 * documents: a Token-2022 mint's ATA lives at a different derived
 * address entirely, so guessing only the legacy program silently reads
 * "no account" forever for those tokens instead of the real balance).
 */
export async function fetchWalletSplTokenBalance(mintAddress: string, decimals: number, ownerAddress: string, {forceFresh = false}: {forceFresh?: boolean} = {}): Promise<number> {
  const key = `solana-token:${mintAddress}:${ownerAddress}`;
  if (!forceFresh) {
    const cached = getCached(key);
    if (cached !== null) return cached;
  }
  let lastError: unknown;
  try {
    const [{TOKEN_2022_PROGRAM_ID}] = await Promise.all([import('@solana/spl-token')]);
    // Standard RPC supports a mint filter; this keeps the Helius path scoped
    // to the requested asset instead of summing every SPL token in the wallet.
    const mintResult = await heliusRpc<{value?: Array<{account?: {data?: {parsed?: {info?: {tokenAmount?: {uiAmount?: number | null}}}}}}>}>(
      'getTokenAccountsByOwner',
      [ownerAddress, {mint: mintAddress}, {encoding: 'jsonParsed', commitment: 'confirmed'}],
    );
    const mintAccounts = mintResult.value ?? [];
    if (mintAccounts.length > 0) {
      const balance = mintAccounts.reduce((sum, item) => sum + (Number(item.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0) || 0), 0);
      setCached(key, balance);
      return balance;
    }
    // Token-2022 fallback: ask for Token-2022 accounts and filter the parsed
    // mint locally because the RPC filter accepts either mint or programId,
    // not both in the same request.
    const token2022Result = await heliusRpc<{value?: Array<{account?: {data?: {parsed?: {info?: {mint?: string; tokenAmount?: {uiAmount?: number | null}}}}}}>}>(
      'getTokenAccountsByOwner',
      [ownerAddress, {programId: TOKEN_2022_PROGRAM_ID.toBase58()}, {encoding: 'jsonParsed', commitment: 'confirmed'}],
    );
    const token2022Accounts = (token2022Result.value ?? []).filter(item => item.account?.data?.parsed?.info?.mint === mintAddress);
    const balance = token2022Accounts.reduce((sum, item) => sum + (Number(item.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0) || 0), 0);
    if (token2022Accounts.length > 0) {
      setCached(key, balance);
      return balance;
    }
    setCached(key, 0);
    return 0;
  } catch (err) {
    lastError = err;
  }
  for (const url of SOLANA_RPC_ENDPOINTS) {
    try {
      const [{Connection, PublicKey}, {getAssociatedTokenAddress, getAccount, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID}] = await Promise.all([import('@solana/web3.js'), import('@solana/spl-token')]);
      const connection = new Connection(url, 'confirmed');
      const mintPubkey = new PublicKey(mintAddress);
      const ownerPubkey = new PublicKey(ownerAddress);
      let balance: number | null = null;
      for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
        try {
          const ata = await getAssociatedTokenAddress(mintPubkey, ownerPubkey, false, programId);
          const account = await getAccount(connection, ata, 'confirmed', programId);
          balance = Number(account.amount) / 10 ** decimals;
          break;
        } catch {
          // No ATA under this program — try the other one before
          // concluding the balance is genuinely zero.
        }
      }
      if (balance === null) balance = 0;
      setCached(key, balance);
      return balance;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error('Could not reach any Solana RPC endpoint.');
}

/**
 * Real native SOL balance — same "quick-percent row needs a real
 * balance" reason fetchWalletNativeBalance above exists, Solana side.
 * Same multi-endpoint fallback as fetchWalletSplTokenBalance.
 */
export async function fetchWalletSolanaBalance(address: string, {forceFresh = false}: {forceFresh?: boolean} = {}): Promise<number> {
  const key = `solana-native:${address}`;
  if (!forceFresh) {
    const cached = getCached(key);
    if (cached !== null) return cached;
  }
  let lastError: unknown;
  try {
    const result = await heliusRpc<{value?: number}>('getBalance', [address, {commitment: 'confirmed'}]);
    if (typeof result.value === 'number') {
      const balance = result.value / 1e9;
      setCached(key, balance);
      return balance;
    }
  } catch (err) {
    lastError = err;
  }
  for (const url of SOLANA_RPC_ENDPOINTS) {
    try {
      const [{Connection, PublicKey}] = await Promise.all([import('@solana/web3.js')]);
      const connection = new Connection(url, 'confirmed');
      const lamports = await connection.getBalance(new PublicKey(address));
      const balance = lamports / 1e9;
      setCached(key, balance);
      return balance;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error('Could not reach any Solana RPC endpoint.');
}

const EVM_NATIVE_TRANSFER_GAS_LIMIT = 21_000n;
const SOLANA_BASE_FEE_LAMPORTS = 5_000;
const SOLANA_RENT_EXEMPT_MINIMUM_LAMPORTS = 890_880;

/**
 * Heuristic gas-reserve estimate for Max on a native "You pay" side —
 * same fallback branch mango-mobile's own sendTransaction.js
 * estimateEvmSendFee uses when there's no known recipient yet (a
 * documented, deliberate case there: a swap/bridge's real destination is
 * a router contract only known once a quote comes back, not before Max
 * is tapped). Not doubled the way that file's own DexScreen.tsx call
 * site doubles it — that reserve covers TWO transactions (a separate
 * protocol-fee transfer, then the swap itself); this app's own
 * executeRelayQuote.ts has no such separate fee transfer — Relay's
 * appFees are deducted atomically from the trade itself — so there is
 * only ever the one transaction to reserve gas for.
 */
export async function estimateEvmNativeFeeReserve(chainKey: ChainKey): Promise<number> {
  const client = getWalletPublicClient(chainKey);
  const {maxFeePerGas} = await client.estimateFeesPerGas();
  const feeWei = EVM_NATIVE_TRANSFER_GAS_LIMIT * maxFeePerGas;
  return Number(feeWei) / 1e18;
}

/** Same reserve math as mango-mobile's own sendTransaction.js estimateSolanaMaxReserveSol — live rent-exemption minimum, falling back to its documented current on-chain value if every RPC endpoint fails. */
export async function estimateSolanaMaxReserveSol(): Promise<number> {
  let rentLamports = SOLANA_RENT_EXEMPT_MINIMUM_LAMPORTS;
  try {
    const result = await heliusRpc<number>('getMinimumBalanceForRentExemption', [0, {commitment: 'confirmed'}]);
    if (Number.isFinite(result) && result > 0) rentLamports = result;
  } catch {}
  for (const url of SOLANA_RPC_ENDPOINTS) {
    try {
      const {Connection} = await import('@solana/web3.js');
      const connection = new Connection(url, 'confirmed');
      const live = await connection.getMinimumBalanceForRentExemption(0);
      if (Number.isFinite(live) && live > 0) rentLamports = live;
      break;
    } catch {
      // Keep trying the next endpoint; the documented fallback above still applies if all of them fail.
    }
  }
  return (rentLamports + SOLANA_BASE_FEE_LAMPORTS) / 1e9;
}

const ERC20_METADATA_ABI = [
  {type: 'function', name: 'symbol', inputs: [], outputs: [{type: 'string'}], stateMutability: 'view'},
  {type: 'function', name: 'decimals', inputs: [], outputs: [{type: 'uint8'}], stateMutability: 'view'},
] as const;

export type TokenMetadata = {symbol: string; decimals: number};

// Cache-forever, not TTL'd like balanceCache above — a token's symbol/
// decimals are fixed the moment its contract/mint is created and can
// never change afterward. Persisted to AsyncStorage (same "survives a
// full app restart" behavior mobile's own PersistentTokenMetadataCache
// has) so re-opening the same token doesn't re-hit RPC for an answer
// that was already known. EVM keys are lowercased (case-insensitive
// addresses); Solana keys are NOT — a base58 mint address is
// case-sensitive, and lowercasing it would silently look up a
// different, wrong address.
const TOKEN_METADATA_STORAGE_KEY = 'mango_pro_token_metadata_cache';
const tokenMetadataCache = new Map<string, TokenMetadata | number>();

getAsyncStorage()
  .then(storage => storage?.getItem(TOKEN_METADATA_STORAGE_KEY))
  .then(raw => {
    const parsed = raw ? (JSON.parse(raw) as Record<string, TokenMetadata | number>) : null;
    if (parsed && typeof parsed === 'object') {
      for (const [key, value] of Object.entries(parsed)) {
        tokenMetadataCache.set(key, value);
      }
    }
  })
  .catch(() => {
    // Storage unavailable or corrupt — the cache just starts empty, nothing else breaks.
  });

function persistTokenMetadataCache(): void {
  const snapshot = JSON.stringify(Object.fromEntries(tokenMetadataCache));
  getAsyncStorage()
    .then(storage => storage?.setItem(TOKEN_METADATA_STORAGE_KEY, snapshot))
    .catch(() => {
      // Best-effort — this lookup just won't survive a restart, nothing else breaks.
    });
}

/** Real on-chain symbol()/decimals() for an arbitrary ERC-20 contract address — the same live verification mobile's own custom-token flow relies on (a real part of the ERC-20 standard, not project-specific). */
export async function fetchErc20TokenMetadata(chainKey: ChainKey, tokenAddress: string): Promise<TokenMetadata> {
  const cacheKey = `evm:${chainKey}:${tokenAddress.toLowerCase()}`;
  const cached = tokenMetadataCache.get(cacheKey);
  if (cached && typeof cached === 'object') return cached;

  const client = getWalletPublicClient(chainKey);
  let symbol: string;
  let decimals: number;
  try {
    const [symbolResult, decimalsResult] = await Promise.all([
      client.readContract({address: tokenAddress as `0x${string}`, abi: ERC20_METADATA_ABI, functionName: 'symbol'}),
      client.readContract({address: tokenAddress as `0x${string}`, abi: ERC20_METADATA_ABI, functionName: 'decimals'}),
    ]);
    symbol = symbolResult;
    decimals = Number(decimalsResult);
  } catch (err) {
    console.error(`[fetchErc20TokenMetadata] ${chainKey}:${tokenAddress}`, err);
    throw new Error("Couldn't verify this token — check the address, or try again in a moment.");
  }
  const result: TokenMetadata = {symbol, decimals};
  tokenMetadataCache.set(cacheKey, result);
  persistTokenMetadataCache();
  return result;
}

/**
 * Real on-chain decimals for an SPL mint address. SPL mints carry no
 * on-chain symbol/name (that lives in an optional, separate Metaplex
 * metadata account this app doesn't parse) — callers already have the
 * symbol from wherever the token was found (search results), so this
 * only ever needs to answer the decimals question.
 *
 * Tries the legacy TOKEN_PROGRAM_ID first, then TOKEN_2022_PROGRAM_ID
 * on a TokenInvalidAccountOwnerError — same real bug fix mobile's own
 * walletRpc.js documents: a mint created under Token-2022 decodes its
 * account data under a completely different owner program, so guessing
 * only the legacy program fails verification for every real Token-2022
 * mint, indistinguishable from a genuinely invalid address. The base
 * MintLayout (where decimals lives) is identical between the two
 * programs, only the owner and any TLV extension data after it differ.
 */
export async function fetchSplMintDecimals(mintAddress: string): Promise<number> {
  const cacheKey = `solana:${mintAddress}`;
  const cached = tokenMetadataCache.get(cacheKey);
  if (typeof cached === 'number') return cached;

  const [{getMint, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID}, {PublicKey}] = await Promise.all([import('@solana/spl-token'), import('@solana/web3.js')]);
  const mintPubkey = new PublicKey(mintAddress);

  for (const url of SOLANA_RPC_ENDPOINTS) {
    const {Connection} = await import('@solana/web3.js');
    const connection = new Connection(url, 'confirmed');
    try {
      const mint = await getMint(connection, mintPubkey, 'confirmed', TOKEN_PROGRAM_ID);
      tokenMetadataCache.set(cacheKey, mint.decimals);
      persistTokenMetadataCache();
      return mint.decimals;
    } catch (err) {
      if (err instanceof Error && err.name === 'TokenInvalidAccountOwnerError') {
        try {
          const mint = await getMint(connection, mintPubkey, 'confirmed', TOKEN_2022_PROGRAM_ID);
          tokenMetadataCache.set(cacheKey, mint.decimals);
          persistTokenMetadataCache();
          return mint.decimals;
        } catch (err2) {
          console.error(`[fetchSplMintDecimals] ${mintAddress}`, err2);
          throw new Error("Couldn't verify this mint — check the address, or try again in a moment.");
        }
      }
      // Not an ownership mismatch — likely a network/RPC-level failure
      // on this endpoint specifically; try the next one before giving up.
    }
  }
  throw new Error("Couldn't verify this mint — check the address, or try again in a moment.");
}
