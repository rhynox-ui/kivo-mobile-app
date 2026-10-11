import React, {useEffect, useState} from 'react';
import {Image, StyleSheet, Text, View} from 'react-native';
import Svg, {Path} from 'react-native-svg';
import type {ChainKey} from '@kivo/trading/core/chainData';
import {dexScreenerChainForChain} from '@kivo/trading/core/dexScreener';
import {NetworkIcon} from '../wallet/NetworkIcon';
import {kivoTheme} from '../theme/kivoTheme';

export function UsdcLogo({size = 32}: {size?: number} = {}) {
  // Circle's official USDC mark.
  return <Svg width={size} height={size} viewBox="0 0 2000 2000"><Path d="M1000 2000c554.17 0 1000-445.83 1000-1000S1554.17 0 1000 0 0 445.83 0 1000s445.83 1000 1000 1000z" fill="#2775CA"/><Path d="M1275 1158.33c0-145.83-87.5-195.83-262.5-216.66-125-16.67-150-50-150-108.34s41.67-95.83 125-95.83c75 0 116.67 25 137.5 87.5 4.17 12.5 16.67 20.83 29.17 20.83h66.66c16.67 0 29.17-12.5 29.17-29.16v-4.17c-16.67-91.67-91.67-162.5-187.5-170.83v-100c0-16.67-12.5-29.17-33.33-33.34h-62.5c-16.67 0-29.17 12.5-33.34 33.34v95.83c-125 16.67-204.16 100-204.16 204.17 0 137.5 83.33 191.66 258.33 212.5 116.67 20.83 154.17 45.83 154.17 112.5s-58.34 112.5-137.5 112.5c-108.34 0-145.84-45.84-158.34-108.34-4.16-16.66-16.66-25-29.16-25h-70.84c-16.66 0-29.16 12.5-29.16 29.17v4.17c16.66 104.16 83.33 179.16 220.83 200v100c0 16.66 12.5 29.16 33.33 33.33h62.5c16.67 0 29.17-12.5 33.34-33.33v-100c125-20.84 208.33-108.34 208.33-220.84z" fill="#FFFFFF"/><Path d="M787.5 1595.83c-325-116.66-491.67-479.16-370.83-800 62.5-175 200-308.33 370.83-370.83 16.67-8.33 25-20.83 25-41.67V325c0-16.67-8.33-29.17-25-33.33-4.17 0-12.5 0-16.67 4.16-395.83 125-612.5 545.84-487.5 941.67 75 233.33 254.17 412.5 487.5 487.5 16.67 0 33.34 0 37.5-16.67 4.17-4.16 4.17-8.33 4.17-16.66v-58.34c0-12.5-12.5-29.16-25-37.5zM1229.17 295.83c-16.67-8.33-33.34 0-37.5 16.67-4.17 4.17-4.17 8.33-4.17 16.67v58.33c0 16.67 12.5 33.33 25 41.67 325 116.66 491.67 479.16 370.83 800-62.5 175-200 308.33-370.83 370.83-16.67 8.33-25 20.83-25 41.67V1700c0 16.67 8.33 29.17 25 33.33 4.17 0 12.5 0 16.67-4.16 395.83-125 612.5-545.84 487.5-941.67-75-237.5-258.34-416.67-487.5-491.67z" fill="#FFFFFF"/></Svg>;
}
const STABLES = new Set(['USDC', 'USDT', 'USDT0', 'USDG']);

/**
 * Prefer the token image supplied by the portfolio/indexer, then retry with
 * DexScreener's contract-specific logo if that URL is stale or unavailable.
 * Never use a logo based on the symbol alone (anyone can create a fake token).
 */
export function TokenIcon({kind, symbol, chainKey, address, imageUrl, size = 38}: {kind: 'native' | 'cash' | 'token'; symbol: string; chainKey: ChainKey; address: string; imageUrl?: string | null; size?: number}) {
  const [sourceIndex, setSourceIndex] = useState(0);
  const box = {width: size, height: size, borderRadius: size / 2};
  if (kind === 'cash' && symbol.toUpperCase() === 'USDC') return <View style={[styles.box, box]}><UsdcLogo size={size} /></View>;
  if (kind === 'native') return <View style={[styles.box, box, styles.bg]}><NetworkIcon chainKey={chainKey} size={Math.round(size * 0.7)} /></View>;

  const ds = dexScreenerChainForChain(chainKey as never);
  const dexScreenerUri = kind === 'token' && ds
    ? `https://dd.dexscreener.com/ds-data/tokens/${ds}/${chainKey === 'solana' ? address : address.toLowerCase()}.png`
    : null;
  const sources = [...new Set([imageUrl, dexScreenerUri].filter((uri): uri is string => typeof uri === 'string' && uri.trim().length > 0))];
  const source = sources[sourceIndex];

  // A row can be reused for a different holding as the portfolio refreshes.
  // Reset the fallback chain when its token or preferred image changes.
  useEffect(() => { setSourceIndex(0); }, [imageUrl, address, chainKey]);

  if (source) {
    return <Image
      key={source}
      source={{uri: source}}
      style={[box, styles.bg]}
      onError={() => setSourceIndex(index => Math.min(index + 1, sources.length))}
    />;
  }
  return <View style={[styles.box, box, styles.bg]}><Text style={styles.letter}>{STABLES.has(symbol.toUpperCase()) ? '$' : symbol.slice(0, 1)}</Text></View>;
}

const styles = StyleSheet.create({
  box: {alignItems: 'center', justifyContent: 'center', overflow: 'hidden'},
  bg: {backgroundColor: kivoTheme.colors.surfaceRaised},
  letter: {color: kivoTheme.colors.text, fontWeight: '800', fontSize: 15},
});
