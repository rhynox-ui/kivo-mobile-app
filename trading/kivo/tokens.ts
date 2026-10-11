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
  return '$' + value.toPrecision(4);
}

export function formatPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return (value >= 0 ? '+' : '') + value.toFixed(2) + '%';
}

export function formatAmount(value: number | null | undefined, maxFractionDigits = 6): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (value === 0) return '0';
  if (Math.abs(value) < 10 ** -maxFractionDigits) return value.toPrecision(3);
  return value.toLocaleString('en-US', {maximumFractionDigits: Math.abs(value) >= 1000 ? 2 : maxFractionDigits});
}

export function shortAddress(address: string | null | undefined, start = 6, end = 4): string {
  if (!address) return '';
  return address.length <= start + end ? address : `${address.slice(0, start)}…${address.slice(-end)}`;
}
