// src/core/chainData.ts
//
// Ported verbatim from mango-bridge.jsx's src/chainData.js — confirmed
// across this whole family of repos to be the cleanest, dependency-free
// version of this data, and the one already trusted to build real
// mainnet Relay quotes. Values are copied, not re-derived, specifically
// so Kivo trading starts from the same already-verified mainnet addresses
// rather than re-typing (and risking re-transcribing wrong) contract
// addresses from scratch.
//
// Per the Kivo trading build plan (§3): this stays a single, carefully
// maintained module inside this repo rather than a published package —
// but every value here should still be treated as load-bearing and
// changed deliberately, the same discipline the site's own file
// documents (currencyAddress() throws rather than guess an unverified
// address).

const NATIVE_TOKEN_ADDRESS = '0x0000000000000000000000000000000000000000';

export type ChainKey =
  | 'ethereum' | 'base' | 'bnb' | 'robinhood' | 'stable' | 'solana'
  | 'arbitrum' | 'avalanche' | 'abstract' | 'hyperevm' | 'ink' | 'plasma'
  | 'unichain' | 'xlayer' | 'arc';

// Arc's native gas balance and this ERC-20 (6 decimals) are the same funds;
// eth_getBalance reports them with 18 decimals.
export const ARC_USDC = '0x3600000000000000000000000000000000000000';

// NEAR has a local wallet signer, Intear route firewall, and 1Click funding path.
export const NEAR_ENABLED = true;
export const NEAR_LABEL = 'NEAR';
/** Native USDC on NEAR (Circle), 6 decimals — the same contract 1Click and the site use. */
export const NEAR_USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
export const NEAR_USDC_DECIMALS = 6;
/** NEAR's own coin, as NEAR's DEX routes name it (the site's rheaSwap.js NATIVE_NEAR). Kivo trading never spends it in a trade — it only pays for storage. */
export const NATIVE_NEAR = 'near';
/** Wrapped NEAR (NEP-141) — what "NEAR" is when traded as a token. */
export const WRAP_NEAR = 'wrap.near';

export const MAINNET_CHAIN_IDS: Record<ChainKey, number> = {
  ethereum: 1,
  base: 8453,
  bnb: 56,
  robinhood: 4663,
  stable: 988,
  // Relay's own internal synthetic id for Solana, not a real EVM chain id.
  solana: 792703809,
  arbitrum: 42161,
  avalanche: 43114,
  abstract: 2741,
  hyperevm: 999,
  ink: 57073,
  plasma: 9745,
  unichain: 130,
  xlayer: 196,
  arc: 5042,
};

export const NATIVE_SYMBOL: Record<ChainKey, string> = {
  ethereum: 'ETH', base: 'ETH', bnb: 'BNB', robinhood: 'ETH',
  stable: 'USDT0',
  solana: 'SOL',
  arbitrum: 'ETH', avalanche: 'AVAX', abstract: 'ETH', hyperevm: 'HYPE',
  ink: 'ETH', plasma: 'XPL', unichain: 'ETH', xlayer: 'OKB',
  arc: 'USDC',
};

// Copied verbatim from mango-mobile's src/wallet/walletAssets.js
// CHAIN_LABEL — same display strings, so a chain reads identically in
// this app's UI as it does on mobile.
export const CHAIN_LABEL: Record<ChainKey, string> = {
  solana: 'Solana',
  ethereum: 'Ethereum',
  base: 'Base',
  bnb: 'BNB Chain',
  robinhood: 'Robinhood Chain',
  stable: 'Stable',
  arbitrum: 'Arbitrum One',
  avalanche: 'Avalanche',
  abstract: 'Abstract',
  hyperevm: 'HyperEVM',
  ink: 'Ink',
  plasma: 'Plasma',
  unichain: 'Unichain',
  xlayer: 'X Layer',
  arc: 'Arc',
};

/**
 * Where a token can be traded: a Relay chain, or NEAR (traded through
 * NEAR's own DEXes — nearTrade.ts). Only search, the chart and the trade
 * screen take this; everything keyed by ChainKey stays as it is.
 */
export type TradeChain = ChainKey | 'near';

export function tradeChainLabel(chain: TradeChain): string {
  return chain === 'near' ? NEAR_LABEL : CHAIN_LABEL[chain];
}

export const TOKEN_ADDRESSES: Record<string, Partial<Record<ChainKey, string>>> = {
  USDC: {
    ethereum: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    avalanche: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
    arbitrum: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    unichain: '0x078D782b760474a361dDA0AF3839290b0EF57AD6',
    solana: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    bnb: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    hyperevm: '0xb88339cb7199b77e23db6e890353e22632ba630f',
    ink: '0x2d270e6886d130d724215a266106e6832161eaed',
    abstract: '0x84A71ccD554Cc1b02749b35d22F684CC8ec987e1',
    xlayer: '0xB6CEceAB302E2E4948951eE7843FC24E92933061',
    arc: ARC_USDC,
  },
  USDT: {
    ethereum: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    bnb: '0x55d398326f99059fF775485246999027B3197955',
    base: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
    arbitrum: '0xFd086bc7CD5C481DCC9C85ebE478A1C0b69FCbb9',
    xlayer: '0x1E4a5963aBFD975d8c9021ce480b42188849D41d',
    solana: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  },
  WBTC: {
    ethereum: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
    base: '0x0555E30da8f98308EdB960aa94C0Db47230d2B9c',
  },
  USDT0: {
    stable: '0x779Ded0c9e1022225f8E0630b35a9b54bE713736',
    plasma: '0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb',
    hyperevm: '0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb',
    ink: '0x0200c29006150606b650577bbe7b6248f58470c1',
  },
  USDG: {
    ethereum: '0xe343167631d89b6ffc58b88d6b7fb0228795491d',
    robinhood: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  },
};

// Relay's Solana API uses the real native-SOL identifier here, not the
// WSOL mint. Relay's official Solana guide lists native SOL as
// 11111111111111111111111111111111 and WSOL separately as
// So11111111111111111111111111111111111111112. Keeping these distinct is
// critical — this exact mistake (using the WSOL mint) is a confirmed,
// live-reported bug elsewhere in this family of apps that made a bridge
// deliver wrapped SOL instead of a spendable native balance.
const NATIVE_PLACEHOLDER_BY_CHAIN: Record<ChainKey, string> = {
  ethereum: NATIVE_TOKEN_ADDRESS,
  base: NATIVE_TOKEN_ADDRESS,
  bnb: NATIVE_TOKEN_ADDRESS,
  robinhood: NATIVE_TOKEN_ADDRESS,
  stable: NATIVE_TOKEN_ADDRESS,
  solana: '11111111111111111111111111111111',
  arbitrum: NATIVE_TOKEN_ADDRESS,
  avalanche: NATIVE_TOKEN_ADDRESS,
  abstract: NATIVE_TOKEN_ADDRESS,
  hyperevm: NATIVE_TOKEN_ADDRESS,
  ink: NATIVE_TOKEN_ADDRESS,
  plasma: NATIVE_TOKEN_ADDRESS,
  unichain: NATIVE_TOKEN_ADDRESS,
  xlayer: NATIVE_TOKEN_ADDRESS,
  // Never the 0x0 sentinel on Arc: that denominates USDC in 18 decimals
  // while every amount here is built with USDC's 6.
  arc: ARC_USDC,
};

// Solana's entry is Relay's own synthetic id (see MAINNET_CHAIN_IDS's
// own comment) — harmless to include here since no real EVM chain will
// ever collide with it, and it lets a caller that already has "a
// chainId from a Relay step" resolve back to a ChainKey generically
// without special-casing Solana out first.
const CHAIN_KEY_BY_CHAIN_ID: Partial<Record<number, ChainKey>> = Object.fromEntries(Object.entries(MAINNET_CHAIN_IDS).map(([key, id]) => [id, key as ChainKey])) as Partial<Record<number, ChainKey>>;

/** Reverse of MAINNET_CHAIN_IDS — undefined for any chain id this app doesn't know about, never guessed. */
export function chainKeyForChainId(chainId: number): ChainKey | undefined {
  return CHAIN_KEY_BY_CHAIN_ID[chainId];
}

export function currencyAddress(chainKey: ChainKey, assetSymbol: string): string {
  if (assetSymbol === NATIVE_SYMBOL[chainKey]) return NATIVE_PLACEHOLDER_BY_CHAIN[chainKey] ?? NATIVE_TOKEN_ADDRESS;
  const addr = TOKEN_ADDRESSES[assetSymbol]?.[chainKey];
  if (!addr) throw new Error(`No verified mainnet contract address for ${assetSymbol} on ${chainKey} — not safe to guess one.`);
  return addr;
}

export function canRelayHandle(fromChainKey: ChainKey, toChainKey: ChainKey, fromAsset: string, toAsset: string): boolean {
  try {
    currencyAddress(fromChainKey, fromAsset);
    currencyAddress(toChainKey, toAsset);
    return true;
  } catch {
    return false;
  }
}

export const ASSET_ONCHAIN_DECIMALS: Record<string, number> = {
  ETH: 18, BNB: 18, USDC: 6, USDT: 6, USDG: 6, WBTC: 8, USDT0: 18,
  SOL: 9, AVAX: 18, HYPE: 18, XPL: 18, OKB: 18,
};

const ASSET_ONCHAIN_DECIMALS_BY_CHAIN: Partial<Record<ChainKey, Record<string, number>>> = {
  bnb: {USDT: 18, USDC: 18},
  plasma: {USDT0: 6},
  hyperevm: {USDT0: 6},
  ink: {USDT0: 6},
};

export function assetDecimalsForChain(chainKey: ChainKey, assetSymbol: string): number | undefined {
  return ASSET_ONCHAIN_DECIMALS_BY_CHAIN[chainKey]?.[assetSymbol] ?? ASSET_ONCHAIN_DECIMALS[assetSymbol];
}
