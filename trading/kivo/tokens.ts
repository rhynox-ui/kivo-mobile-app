// Kivo token model + trade-support rules shared by web and mobile.
//
// Every surface (search, trending, token detail, trade ticket, chat token
// cards) passes this one shape around, so a token picked anywhere lands
// on the Trade screen with the same chain/address the engine will quote.

import {CHAIN_LABEL, MAINNET_CHAIN_IDS, NATIVE_SYMBOL, TOKEN_ADDRESSES, tradeChainLabel, type ChainKey, type TradeChain} from '../core/chainData';
import {CHAIN_KEY_TO_VIEM_CHAIN} from '../core/chainRegistry';

export type KivoToken = {
  chainKey: TradeChain;
  tokenAddress: string;
  symbol: string;
  name: string;
  imageUrl: string | null;
  priceUsd: number | null;
  change24h: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  volumeUsd24h?: number | null;
  /** 24h buy+sell count, when the market source reports it. */
  txCount24h?: number | null;
  /** Unix ms the token/pair was created, when the market source reports it. */
  createdAt?: number | null;
};

export type TradeSide = 'buy' | 'sell';

/** Which wallet is signing — decides which chains a session can actually execute on. */
export type WalletKind = 'evm-browser' | 'evm-local' | 'evm-watch' | 'solana-browser';

export type TradeSupport = {ok: true; chainKey: TradeChain} | {ok: false; reason: string};

/** EVM chains Kivo can quote, read balances on and sign for. Solana/NEAR are deliberately absent until a matching signer exists. */
export const EVM_TRADE_CHAINS: ChainKey[] = (Object.keys(MAINNET_CHAIN_IDS) as ChainKey[]).filter(key => key !== 'solana' && Boolean(CHAIN_KEY_TO_VIEM_CHAIN[key]));

/** Chains where Kivo has a verified USDC contract, i.e. where a user can pay with or receive cash. */
export const USDC_CHAINS: ChainKey[] = EVM_TRADE_CHAINS.filter(key => Boolean(TOKEN_ADDRESSES.USDC?.[key]));

export function chainLabel(chain: TradeChain): string {
  return tradeChainLabel(chain);
}

export function isEvmTradeChain(chain: TradeChain): chain is ChainKey {
  return chain !== 'near' && EVM_TRADE_CHAINS.includes(chain);
}

/**
 * Honest gate in front of the quote engine. A token that fails here is
 * still shown (search/detail work everywhere) but the trade button says
 * exactly why it can't be traded from this wallet yet.
 */
export function tradeSupportFor(token: Pick<KivoToken, 'chainKey' | 'tokenAddress'>, wallet: {kind: WalletKind} | null): TradeSupport {
  if (token.chainKey === 'near') {
    if (wallet?.kind === 'evm-watch') return {ok: false, reason: 'This wallet is connected read-only. Create or import a wallet on this device to sign NEAR trades.'};
    return {ok: true, chainKey: 'near'};
  }
  if (token.chainKey === 'solana') {
    if (wallet?.kind === 'evm-watch') return {ok: false, reason: 'This wallet is connected read-only. Create or import a wallet on this device to sign trades.'};
    return {ok: true, chainKey: 'solana'};
  }
  if (!isEvmTradeChain(token.chainKey)) return {ok: false, reason: `${CHAIN_LABEL[token.chainKey] ?? token.chainKey} is not available for trading yet.`};
  if (!/^0x[0-9a-fA-F]{40}$/.test(token.tokenAddress)) return {ok: false, reason: 'This token address is not a valid EVM contract address.'};
  if (wallet?.kind === 'evm-watch') return {ok: false, reason: 'This wallet is connected read-only. Create or import a wallet on this device to sign trades.'};
  return {ok: true, chainKey: token.chainKey};
}

export function nativeSymbol(chainKey: ChainKey): string {
  return NATIVE_SYMBOL[chainKey];
}

export function tokenKey(token: Pick<KivoToken, 'chainKey' | 'tokenAddress'>): string {
  return `${token.chainKey}:${token.tokenAddress.toLowerCase()}`;
}

/** Accepts either core search results or discovery-feed tokens and normalizes them to KivoToken. */
export function toKivoToken(input: {
  chainKey: TradeChain;
  tokenAddress: string;
  symbol: string;
  name: string;
  imageUrl: string | null;
  priceUsd: number | null;
  change24h: number | null;
  marketCapUsd: number | null;
  liquidityUsd?: number | null;
  volumeUsd24h?: number | null;
  txCount24h?: number | null;
  createdAt?: number | null;
}): KivoToken {
  return {
    chainKey: input.chainKey,
    tokenAddress: input.tokenAddress,
    symbol: input.symbol,
    name: input.name,
    imageUrl: input.imageUrl,
    priceUsd: input.priceUsd,
    change24h: input.change24h,
    marketCapUsd: input.marketCapUsd,
    liquidityUsd: input.liquidityUsd ?? null,
    volumeUsd24h: input.volumeUsd24h ?? null,
    txCount24h: input.txCount24h ?? null,
    createdAt: input.createdAt ?? null,
  };
}

export function formatUsd(value: number | null | undefined, options: {compact?: boolean} = {}): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (options.compact) {
    const abs = Math.abs(value);
    if (abs >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
    if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
    if (abs >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  }
  if (Math.abs(value) >= 1) return '$' + value.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
  if (value === 0) return '$0.00';
  // Four significant digits as plain decimals: $0.0000004438, never "4.438e-7".
  const decimals = Math.min(20, Math.max(2, 3 - Math.floor(Math.log10(Math.abs(value)))));
  return (value < 0 ? '-$' : '$') + Math.abs(value).toFixed(decimals).replace(/(\.\d*?[1-9])0+$/, '$1');
}

/** A wallet balance in dollars: dust below one cent reads "<$0.01" (prices keep using formatUsd). */
export function formatBalanceUsd(value: number | null | undefined): string {
  if (value != null && Number.isFinite(value) && value > 0 && value < 0.01) return '<$0.01';
  return formatUsd(value);
}

export function formatPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return (value >= 0 ? '+' : '') + value.toFixed(2) + '%';
}

export function formatAmount(value: number | null | undefined, maxFractionDigits = 6): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (value === 0) return '0';
  // Three significant digits as plain decimals, never "4.43e-7".
  if (Math.abs(value) < 10 ** -maxFractionDigits) return value.toFixed(Math.min(20, 2 - Math.floor(Math.log10(Math.abs(value))))).replace(/(\.\d*?[1-9])0+$/, '$1');
  return value.toLocaleString('en-US', {maximumFractionDigits: Math.abs(value) >= 1000 ? 2 : maxFractionDigits});
}

export function shortAddress(address: string | null | undefined, start = 6, end = 4): string {
  if (!address) return '';
  return address.length <= start + end ? address : `${address.slice(0, start)}…${address.slice(-end)}`;
}

const SOLANA_NATIVE = '11111111111111111111111111111111';
const EVM_NATIVE = new Set(['0x0000000000000000000000000000000000000000', '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee']);

/** A network's own coin (ETH, BNB, SOL…) rather than a token contract. Relay trades it directly. */
export function isNativeToken(token: Pick<KivoToken, 'chainKey' | 'tokenAddress'>): boolean {
  return token.chainKey === 'solana' ? token.tokenAddress === SOLANA_NATIVE : EVM_NATIVE.has(token.tokenAddress.toLowerCase());
}

/**
 * Native coins have no contract, so charts and market data use the wrapped
 * coin's well-known address (WETH, WBNB, WAVAX, WSOL). Null where Kivo knows
 * no wrapped address for that network.
 */
const WRAPPED_NATIVE: Partial<Record<TradeChain, string>> = {
  ethereum: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  base: '0x4200000000000000000000000000000000000006',
  arbitrum: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
  unichain: '0x4200000000000000000000000000000000000006',
  ink: '0x4200000000000000000000000000000000000006',
  bnb: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
  avalanche: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7',
  solana: 'So11111111111111111111111111111111111111112',
};

/** The address to look a token up by on market sites (the wrapped coin for a native coin). */
export function marketAddressFor(token: Pick<KivoToken, 'chainKey' | 'tokenAddress'>): string | null {
  return isNativeToken(token) ? WRAPPED_NATIVE[token.chainKey] ?? null : token.tokenAddress;
}

/** A network's own coin as a tradeable Kivo token (buy or sell ETH, BNB, SOL… like any token). */
export function nativeKivoToken(chainKey: ChainKey, priceUsd: number | null = null): KivoToken {
  const symbol = NATIVE_SYMBOL[chainKey];
  return {chainKey, tokenAddress: chainKey === 'solana' ? SOLANA_NATIVE : '0x0000000000000000000000000000000000000000', symbol, name: `${symbol} · ${CHAIN_LABEL[chainKey]}`, imageUrl: null, priceUsd, change24h: null, marketCapUsd: null, liquidityUsd: null};
}
