import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { TradeIntent } from '../domain/trade';
import type { TradeQuote } from '../domain/tradeQuote';
import { executionGate } from '../domain/tradeSafety';
import { quoteToSummary } from '../domain/tradeQuote';
import { kivoTheme } from '../theme/kivoTheme';

export function TradeConfirmation({intent, quote, onConfirm}:{intent:TradeIntent; quote:TradeQuote; onConfirm:()=>void}) {
  const blocked = executionGate(quote,intent) !== null;
  const summary = quoteToSummary(quote);
  return <View style={styles.card}>
    <Text style={styles.title}>Confirm trade</Text>
    <Text style={styles.route}>{intent.inputToken.symbol} → {intent.outputToken.symbol}</Text>
    <View style={styles.row}><Text style={styles.label}>You pay</Text><Text style={styles.value}>{intent.amount} {intent.inputToken.symbol}</Text></View>
    <View style={styles.row}><Text style={styles.label}>You receive</Text><Text style={styles.value}>{quote.outputAmount} {quote.output.symbol}</Text></View>
    <View style={styles.row}><Text style={styles.label}>Fee</Text><Text style={styles.value}>{summary.fee}</Text></View>
    <View style={styles.row}><Text style={styles.label}>Impact</Text><Text style={styles.value}>{summary.impact}</Text></View>
    <Pressable disabled={blocked} onPress={onConfirm} style={[styles.button,blocked&&styles.disabled]} accessibilityRole="button">
      <Text style={styles.buttonText}>{blocked?'Quote needs refresh':'Confirm trade'}</Text>
    </Pressable>
  </View>;
}
const styles=StyleSheet.create({card:{marginTop:14,padding:16,borderRadius:20,backgroundColor:kivoTheme.colors.surface,borderWidth:1,borderColor:kivoTheme.colors.border},title:{color:kivoTheme.colors.text,fontSize:17,fontWeight:'800'},route:{color:kivoTheme.colors.accent,fontSize:12,fontWeight:'700',marginTop:5},row:{flexDirection:'row',justifyContent:'space-between',marginTop:14},label:{color:kivoTheme.colors.textMuted,fontSize:11},value:{color:kivoTheme.colors.text,fontSize:12,fontWeight:'800'},button:{marginTop:18,height:46,borderRadius:14,alignItems:'center',justifyContent:'center',backgroundColor:kivoTheme.colors.accent},disabled:{opacity:.45},buttonText:{color:kivoTheme.colors.backgroundDeep,fontWeight:'900'}});
