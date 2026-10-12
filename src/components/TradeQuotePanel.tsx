import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { TradeQuote } from '../domain/tradeQuote';
import { quoteToSummary, isQuoteFresh } from '../domain/tradeQuote';
import { kivoTheme } from '../theme/kivoTheme';

export function TradeQuotePanel({ quote, now = Date.now() }: { quote: TradeQuote | null; now?: number }) {
  if (!quote) return <View style={styles.card}><Text style={styles.title}>Quote</Text><Text style={styles.muted}>Enter an amount to request a live route quote.</Text></View>;
  const fresh = isQuoteFresh(quote, now);
  const summary = quoteToSummary(quote);
  return <View style={styles.card}>
    <View style={styles.row}><Text style={styles.title}>Quote</Text><Text style={[styles.status, fresh ? styles.ready : styles.expired]}>{fresh ? 'LIVE' : 'EXPIRED'}</Text></View>
    <View style={styles.receive}><Text style={styles.muted}>You receive</Text><Text style={styles.output}>{summary.outputAmount} {quote.output.symbol}</Text></View>
    <View style={styles.grid}><Metric label="Fee" value={summary.fee}/><Metric label="Price impact" value={summary.impact}/><Metric label="ETA" value={summary.eta}/></View>
    {!fresh ? <Text style={styles.warning}>This quote is stale. Request a new quote before signing.</Text> : null}
  </View>;
}
function Metric({label,value}:{label:string;value:string}){return <View style={styles.metric}><Text style={styles.muted}>{label}</Text><Text style={styles.value}>{value}</Text></View>}
const styles=StyleSheet.create({card:{marginTop:14,padding:15,borderRadius:18,backgroundColor:kivoTheme.colors.surface,borderWidth:1,borderColor:kivoTheme.colors.border},row:{flexDirection:'row',alignItems:'center',justifyContent:'space-between'},title:{color:kivoTheme.colors.text,fontSize:14,fontWeight:'800'},status:{fontSize:9,fontWeight:'900',letterSpacing:1},ready:{color:kivoTheme.colors.success},expired:{color:kivoTheme.colors.danger},receive:{marginTop:13,padding:12,borderRadius:13,backgroundColor:kivoTheme.colors.surfaceRaised},muted:{color:kivoTheme.colors.textMuted,fontSize:10},output:{color:kivoTheme.colors.cream,fontSize:17,fontWeight:'800',marginTop:4},grid:{flexDirection:'row',gap:8,marginTop:12},metric:{flex:1,padding:9,borderRadius:11,backgroundColor:kivoTheme.colors.backgroundDeep},value:{color:kivoTheme.colors.text,fontSize:11,fontWeight:'800',marginTop:3},warning:{color:kivoTheme.colors.danger,fontSize:10,lineHeight:15,marginTop:10}});
