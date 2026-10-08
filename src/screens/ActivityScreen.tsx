import React, {useEffect, useState} from 'react';
import {Linking, Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {kivoTheme} from '../theme/kivoTheme';
import {explorerTxUrl, fetchRelayStatus, relayRequestUrl} from '@kivo/trading/kivo/execute';
import {subscribeToTradeHistory, updateTradeStatus, type TradeRecord} from '@kivo/trading/kivo/history';
import {formatAmount, shortAddress} from '@kivo/trading/kivo/tokens';

export function ActivityScreen({onBack}: {onBack: () => void}) {
  const [trades,setTrades]=useState<TradeRecord[]>([]);
  const [refreshing,setRefreshing]=useState<string|null>(null);
  useEffect(()=>subscribeToTradeHistory(setTrades),[]);
  const refresh=async(trade:TradeRecord)=>{
    if(!trade.requestId||refreshing)return;
    setRefreshing(trade.id);
    try {
      const status=await fetchRelayStatus(trade.requestId);
      if(status==='success')updateTradeStatus(trade.id,'success');
      else if(status==='refund')updateTradeStatus(trade.id,'refunded');
      else if(status==='failure')updateTradeStatus(trade.id,'failed');
    } finally {setRefreshing(null);}
  };
  return <View style={styles.root}>
    <View style={styles.header}>
      <Pressable onPress={onBack} hitSlop={10}><Text style={styles.back}>‹</Text></Pressable>
      <Text style={styles.title}>History</Text>
    </View>
    {trades.length===0
      ? <View style={styles.empty}><Text style={styles.emptyText}>No trades yet — your executed trades will show up here.</Text></View>
      : <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        {trades.map(trade=><View key={trade.id} style={styles.item}>
          <View style={[styles.dot,trade.status!=='success'&&styles.dotPending]}/>
          <View style={styles.main}>
            <View style={styles.top}>
              <Text style={styles.rowTitle}>{trade.side==='buy'?'Bought':'Sold'} {trade.token.symbol}</Text>
              <Text style={[styles.status,trade.status==='success'?styles.ok:trade.status==='failed'?styles.bad:trade.status==='refunded'?styles.refunded:styles.pending]}>{trade.status}</Text>
            </View>
            <Text style={styles.subtitle} numberOfLines={1}>{trade.pay.amount} {trade.pay.symbol} → {trade.receive.amount?formatAmount(Number(trade.receive.amount)):'—'} {trade.receive.symbol}</Text>
            <Text style={styles.when}>{new Date(trade.createdAt).toLocaleString()}</Text>
            {trade.txHashes.map((hash,index)=>{
              const url=explorerTxUrl(trade.chainIds[index]??trade.chainIds[0]??0,hash);
              return <Pressable key={hash} disabled={!url} onPress={()=>url&&Linking.openURL(url)}>
                <Text style={styles.link}>{trade.txHashes.length>1?`Transaction ${index+1}: `:''}{shortAddress(hash,10,6)}</Text>
              </Pressable>;
            })}
            {trade.requestId&&<View style={styles.actions}>
              <Pressable onPress={()=>Linking.openURL(relayRequestUrl(trade.requestId!))}><Text style={styles.link}>Route status</Text></Pressable>
              {trade.status==='pending'&&<Pressable onPress={()=>refresh(trade)} disabled={refreshing===trade.id}><Text style={styles.link}>{refreshing===trade.id?'Checking…':'Check now'}</Text></Pressable>}
            </View>}
            {trade.error?<Text style={styles.error}>{trade.error}</Text>:null}
          </View>
        </View>)}
      </ScrollView>}
  </View>;
}
const c=kivoTheme.colors;
const styles=StyleSheet.create({
 root:{flex:1,backgroundColor:c.background,paddingHorizontal:16},
 header:{paddingTop:8,paddingBottom:8,flexDirection:'row',alignItems:'center',gap:8},
 back:{color:c.textMuted,fontSize:34,lineHeight:34},
 title:{color:c.text,fontSize:30,fontWeight:'800'},
 body:{paddingBottom:32},
 item:{flexDirection:'row',alignItems:'flex-start',gap:10,paddingVertical:13,borderBottomWidth:1,borderBottomColor:c.border},
 dot:{width:8,height:8,borderRadius:4,backgroundColor:c.success,marginTop:6},
 dotPending:{backgroundColor:'#F2C96D'},
 main:{flex:1,minWidth:0},
 top:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',gap:8},
 rowTitle:{color:c.text,fontSize:13.5,fontWeight:'800',flex:1},
 status:{fontSize:9.5,fontWeight:'800',textTransform:'uppercase'},
 ok:{color:c.success},bad:{color:c.danger},refunded:{color:'#F2C96D'},pending:{color:c.textMuted},
 subtitle:{color:c.textMuted,fontSize:11.5,marginTop:3},
 when:{color:c.textMuted,fontSize:10.5,marginTop:2},
 actions:{flexDirection:'row',gap:18},
 link:{color:c.accent,fontSize:11.5,fontWeight:'700',marginTop:7},
 error:{color:c.danger,fontSize:11,marginTop:7},
 empty:{flex:1,alignItems:'center',justifyContent:'center',paddingHorizontal:24},
 emptyText:{color:c.textMuted,fontSize:13,textAlign:'center',lineHeight:19}
});