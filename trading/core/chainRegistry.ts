// src/core/chainRegistry.ts
//
// Scoped port of mango-mobile's own src/wallet/chainRegistry.js — same
// verified, independently-sourced RPC fallback list and viem chain
// definitions, cut down to exactly the chains in this app's own
// ChainKey (chainData.ts), not mobile's much broader 60+-chain wallet-
// dashboard expansion. Every RPC URL here is copied from mobile's own
// already-verified list, not re-researched or guessed.

import {createPublicClient, createWalletClient, http, fallback, defineChain, type Chain} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {mainnet, base, bsc, arbitrum, avalanche, abstract, hyperEvm, ink, plasma, unichain, xLayer} from 'viem/chains';
import type {ChainKey} from './chainData';

// Same first-two-tiers-per-chain fallback list mobile's own
// chainRegistry.js carries (independently sourced from each chain's own
// docs) — see that file's own header for the Base rate-limit history
// this list already accounts for (mainnet.base.org deliberately excluded).
export const RPC_FALLBACKS: Partial<Record<number, string[]>> = {
  1: ['https://ethereum.reth.rs/rpc', 'https://ethereum.publicnode.com'],
  8453: ['https://base.publicnode.com', 'https://base.drpc.org'],
  56: ['https://bsc-dataseed.bnbchain.org', 'https://bsc-dataseed1.defibit.io'],
  42161: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum.publicnode.com'],
  43114: ['https://api.avax.network/ext/bc/C/rpc', 'https://avalanche.publicnode.com'],
  2741: ['https://api.mainnet.abs.xyz'],
  999: ['https://rpc.hyperliquid.xyz/evm'],
  57073: ['https://rpc-gel.inkonchain.com', 'https://rpc-qnd.inkonchain.com'],
  9745: ['https://rpc.plasma.to'],
  130: ['https://mainnet.unichain.org', 'https://unichain.publicnode.com'],
  196: ['https://xlayerrpc.okx.com', 'https://rpc.xlayer.tech'],
  4663: ['https://rpc.mainnet.chain.robinhood.com', 'https://robinhood-rpc.publicnode.com'],
  988: ['https://rpc.stable.xyz'],
  // Arc's own four public mainnet endpoints, as listed in viem 2.56.9's
  // official `arc` chain (the installed 2.56.3 ships an empty stub).
  5042: ['https://rpc.mainnet.arc.io', 'https://rpc.drpc.mainnet.arc.io', 'https://rpc.blockdaemon.mainnet.arc.io', 'https://rpc.quicknode.mainnet.arc.io'],
};

export function transportFor(chainId: number) {
  const urls = (RPC_FALLBACKS[chainId] || []).filter(Boolean);
  if (urls.length === 0) return http();
  return fallback(urls.map(url => http(url)));
}

// Robinhood Chain and Stable aren't in viem's own maintained chain list —
// defined manually, values independently verified from each chain's own
// docs (docs.robinhood.com/chain, docs.stable.xyz), same as mobile's copy.
const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';

export const robinhoodMainnet = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18},
  rpcUrls: {default: {http: ['https://rpc.mainnet.chain.robinhood.com']}},
  blockExplorers: {default: {name: 'Robinhood Chain Explorer', url: 'https://robinhoodchain.blockscout.com'}},
  testnet: false,
});

export const stableMainnet = defineChain({
  id: 988,
  name: 'Stable',
  nativeCurrency: {name: 'USDT0', symbol: 'USDT0', decimals: 18},
  rpcUrls: {default: {http: ['https://rpc.stable.xyz']}},
  blockExplorers: {default: {name: 'StableScan', url: 'https://stablescan.xyz'}},
  contracts: {multicall3: {address: MULTICALL3_ADDRESS}},
  testnet: false,
});

// Arc's native gas token is USDC. viem reports it with 18 decimals (that
// is what eth_getBalance returns); the ERC-20 view at 0x3600… reports the
// same funds with 6. Nothing here should ever mix the two.
export const arcMainnet = defineChain({
  id: 5042,
  name: 'Arc',
  nativeCurrency: {name: 'USDC', symbol: 'USDC', decimals: 18},
  rpcUrls: {default: {http: ['https://rpc.mainnet.arc.io']}},
  blockExplorers: {default: {name: 'Arc Explorer', url: 'https://explorer.arc.io'}},
  contracts: {multicall3: {address: MULTICALL3_ADDRESS}},
  testnet: false,
});

// solana has no viem Chain object — callers branch on chainKey === 'solana'
// before ever reaching this map, same convention chainData.ts's own
// NATIVE_PLACEHOLDER_BY_CHAIN uses.
export const CHAIN_KEY_TO_VIEM_CHAIN: Partial<Record<ChainKey, Chain>> = {
  ethereum: mainnet,
  base: base,
  bnb: bsc,
  robinhood: robinhoodMainnet,
  stable: stableMainnet,
  arbitrum: arbitrum,
  avalanche: avalanche,
  abstract: abstract,
  hyperevm: hyperEvm,
  ink: ink,
  plasma: plasma,
  unichain: unichain,
  xlayer: xLayer,
  arc: arcMainnet,
};

export function getViemChain(chainKey: ChainKey): Chain {
  const chain = CHAIN_KEY_TO_VIEM_CHAIN[chainKey];
  if (!chain) {
    throw new Error(`No EVM chain configured for "${chainKey}" — is this a Solana call using the wrong path?`);
  }
  return chain;
}

// Reverse lookup for the fallback-DEX provider files (uniswapV3.ts and
// siblings), which are indexed by raw numeric EVM chain id — the same
// convention Uniswap/SushiSwap/PancakeSwap's own per-chain deployment
// tables use — rather than this app's own ChainKey.
export function viemChainForChainId(chainId: number): Chain | undefined {
  return Object.values(CHAIN_KEY_TO_VIEM_CHAIN).find(chain => chain?.id === chainId);
}

export function publicClientForChainId(chainId: number) {
  const chain = viemChainForChainId(chainId);
  if (!chain) throw new Error(`No EVM chain configured for chain id ${chainId}.`);
  return createPublicClient({chain, transport: transportFor(chainId)});
}

export function clientsForChainId(chainId: number, privateKeyHex: string) {
  const chain = viemChainForChainId(chainId);
  if (!chain) throw new Error(`No EVM chain configured for chain id ${chainId}.`);
  const account = privateKeyToAccount(privateKeyHex as `0x${string}`);
  const transport = transportFor(chainId);
  return {
    walletClient: createWalletClient({account, chain, transport}),
    publicClient: createPublicClient({chain, transport}),
  };
}
