// src/core/geckoTerminalNetworks.ts
//
// Ported verbatim (values only, re-typed) from the reference mobile app's own
// src/wallet/geckoTerminalNetworks.js — that file's own header explains
// why these IDs are hand-verified against GeckoTerminal's real /networks
// endpoint rather than guessed from a chain's name or EVM chain ID, and
// why an unmapped chain must resolve to null (a missing trending source
// is a garnish this app can live without) rather than throw or guess.
// Trimmed to the ChainKeys this app actually has — 'stable' has no
// verified GeckoTerminal network ID in mobile's own registry either, so
// it resolves to null here too, same as it would there.
//
// Verified (2026-09) that Flap/Four.meme (BNB Chain), Long.xyz (Robinhood
// Chain), and StonkFun (Solana) all resolve to chains already mapped
// here, so discoveryFeed.ts's per-chain trending_pools fetch — which is
// NOT filtered to any one DEX/launchpad — already has a real path to
// surface their tokens once traded on an indexed DEX (PancakeSwap V3 for
// Flap/Four.meme, Raydium/PumpSwap for StonkFun, Robinhood Chain's own
// Uniswap V3/PancakeSwap V3/RobinSwap/Bankr/Virtuals for Long.xyz).
// Four.meme's own bonding-curve pools are directly confirmed indexed by
// GeckoTerminal even pre-graduation; Flap's and Long.xyz's own bonding-
// curve stage is not independently confirmed the same way — a real,
// disclosed gap, not assumed covered.

import type {ChainKey} from './chainData';

const VERIFIED_NETWORK_IDS: Partial<Record<ChainKey, string>> = {
  ethereum: 'eth',
  base: 'base',
  bnb: 'bsc',
  robinhood: 'robinhood',
  solana: 'solana',
  arbitrum: 'arbitrum',
  avalanche: 'avax',
  abstract: 'abstract',
  hyperevm: 'hyperevm',
  ink: 'ink',
  plasma: 'plasma',
  unichain: 'unichain',
  xlayer: 'x-layer',
  arc: 'arc',
};

export function geckoTerminalNetworkForChainOrNull(chainKey: ChainKey): string | null {
  return VERIFIED_NETWORK_IDS[chainKey] ?? null;
}
