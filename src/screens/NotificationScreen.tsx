import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { kivoTheme } from '../theme/kivoTheme';
import { getNotifications, markAllNotificationsRead, subscribeToNotifications, type KivoNotification } from '../state/notificationStore';

export function NotificationScreen({onBack}:{onBack?:()=>void}){
 const [items,setItems]=useState<KivoNotification[]>(getNotifications);
 useEffect(()=>{ return subscribeToNotifications(setItems); },[]);
 const unread=items.filter(item=>!item.read).length;
 return <View style={styles.root}>
   <View style={styles.header}><Pressable onPress={onBack}><Text style={styles.back}>‹</Text></Pressable><View><Text style={styles.eyebrow}>KIVO</Text><Text style={styles.title}>Notifications</Text></View><Pressable onPress={markAllNotificationsRead}><Text style={styles.read}>Read all</Text></Pressable></View>
   <ScrollView contentContainerStyle={styles.body}>
    {items.length===0 ? <View style={styles.card}><Text style={styles.cardTitle}>You're all caught up</Text><Text style={styles.cardText}>Mentions, group activity and trade events will appear here.</Text></View> : items.map(item=><View key={item.id} style={[styles.item,!item.read&&styles.unread]}><View style={styles.dot}/><View style={styles.copy}><Text style={styles.itemTitle}>{item.title}</Text><Text style={styles.itemBody}>{item.body}</Text><Text style={styles.time}>{new Date(item.createdAt).toLocaleString()}</Text></View></View>)}
    {unread>0&&<Text style={styles.footer}>{unread} unread</Text>}
   </ScrollView>
 </View>
}
const styles=StyleSheet.create({root:{flex:1,backgroundColor:kivoTheme.colors.background},header:{minHeight:78,paddingHorizontal:18,flexDirection:'row',alignItems:'center',borderBottomWidth:1,borderBottomColor:kivoTheme.colors.border},back:{color:kivoTheme.colors.cream,fontSize:38,width:35},eyebrow:{color:kivoTheme.colors.accent,fontSize:9,fontWeight:'800',letterSpacing:1.5},title:{color:kivoTheme.colors.text,fontSize:23,fontWeight:'800',marginTop:2},read:{color:kivoTheme.colors.accent,fontSize:10,fontWeight:'800',marginLeft:'auto'},body:{padding:18,paddingBottom:40},card:{backgroundColor:kivoTheme.colors.surface,borderRadius:18,borderWidth:1,borderColor:kivoTheme.colors.border,padding:18},cardTitle:{color:kivoTheme.colors.text,fontWeight:'800'},cardText:{color:kivoTheme.colors.textMuted,fontSize:13,lineHeight:20,marginTop:7},item:{flexDirection:'row',padding:15,borderRadius:16,backgroundColor:kivoTheme.colors.surface,borderWidth:1,borderColor:kivoTheme.colors.border,marginBottom:9},unread:{borderColor:kivoTheme.colors.accent},dot:{width:7,height:7,borderRadius:4,backgroundColor:kivoTheme.colors.accent,marginTop:6,marginRight:11},copy:{flex:1},itemTitle:{color:kivoTheme.colors.text,fontSize:13,fontWeight:'800'},itemBody:{color:kivoTheme.colors.textMuted,fontSize:11.5,lineHeight:17,marginTop:4},time:{color:kivoTheme.colors.textMuted,fontSize:9,marginTop:7},footer:{color:kivoTheme.colors.textMuted,textAlign:'center',fontSize:10,marginTop:8}});
