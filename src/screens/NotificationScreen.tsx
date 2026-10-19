import React, { useCallback, useEffect, useState } from 'react';
import { AppState, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { kivoTheme } from '../theme/kivoTheme';
import { getNotifications, markAllNotificationsRead, subscribeToNotifications, type KivoNotification } from '../state/notificationStore';
import { api, enableSocial, socialReady } from '../state/session';
import type { FeedPostNotification } from '@kivo/shared/api/client';
import { userLabel } from '@kivo/shared/api/types';

type Props = {onBack?:()=>void; onOpenPost?:(postId:string)=>void};
type FeedItem = FeedPostNotification & {source:'feed'};
type LocalItem = KivoNotification & {source:'local'};
type Item = FeedItem | LocalItem;
const kindLabel = (item:FeedPostNotification) => item.kind==='like'?'liked your post':item.kind==='dislike'?'disliked your post':item.kind==='reply'?'commented on your post':'published a post';

export function NotificationScreen({onBack,onOpenPost}:Props){
 const [items,setItems]=useState<Item[]>(()=>getNotifications().map(item=>({...item,source:'local'})));
 const [feedItems,setFeedItems]=useState<FeedPostNotification[]>([]);
 const [loading,setLoading]=useState(false);
 const [error,setError]=useState('');
 const refresh=useCallback(async()=>{
   if(!socialReady())return;
   setLoading(true);setError('');
   try{setFeedItems(await api.feedNotifications());}
   catch(e){setError(e instanceof Error?e.message:'Could not load feed notifications.');}
   finally{setLoading(false);}
 },[]);
 useEffect(()=>{const unsub=subscribeToNotifications(rows=>setItems(rows.map(item=>({...item,source:'local'}))));void refresh();const sub=AppState.addEventListener('change',state=>{if(state==='active')void refresh();});return()=>{unsub();sub.remove();};},[refresh]);
 const merged:Item[]=[...feedItems.map(item=>({...item,source:'feed' as const})),...items].sort((a,b)=>b.createdAt-a.createdAt);
 const unread=merged.filter(item=>item.source==='feed'?!item.readAt:!item.read).length;
 const markRead=async()=>{markAllNotificationsRead();if(socialReady()){try{await api.markFeedNotificationsRead();setFeedItems(old=>old.map(item=>({...item,readAt:item.readAt??Date.now()})));}catch(e){setError(e instanceof Error?e.message:'Could not mark notifications read.');}}};
 const openItem=(item:Item)=>{if(item.source==='feed'){if(!item.readAt){setFeedItems(old=>old.map(n=>n.id===item.id?{...n,readAt:Date.now()}:n));}onOpenPost?.(item.postId);}};
 return <View style={styles.root}>
   <View style={styles.header}><Pressable onPress={onBack}><Text style={styles.back}>‹</Text></Pressable><View><Text style={styles.eyebrow}>KIVO</Text><Text style={styles.title}>Notifications</Text></View><Pressable onPress={()=>void markRead()}><Text style={styles.read}>Read all</Text></Pressable></View>
   <ScrollView contentContainerStyle={styles.body}>
    {loading&&<Text style={styles.status}>Syncing feed notifications…</Text>}
    {!!error&&<Text style={styles.status}>{error}</Text>}
    {merged.length===0 ? <View style={styles.card}><Text style={styles.cardTitle}>You're all caught up</Text><Text style={styles.cardText}>Likes, comments, new posts and messages will appear here.</Text>{!socialReady()&&<Pressable onPress={()=>void enableSocial().then(refresh).catch(e=>setError(e instanceof Error?e.message:'Could not connect social account.'))}><Text style={styles.read}>Connect Kivo Social</Text></Pressable>}</View> : merged.map(item=><Pressable key={item.source+item.id} onPress={()=>openItem(item)} disabled={item.source==='local'} style={[styles.item,(item.source==='feed'?!item.readAt:!item.read)&&styles.unread]}><View style={styles.dot}/><View style={styles.copy}><Text style={styles.itemTitle}>{item.source==='feed'?userLabel(item.actorUsername,item.actorId)+' '+kindLabel(item):item.title}</Text><Text style={styles.itemBody}>{item.source==='feed'?item.postPreview:item.body}</Text><Text style={styles.time}>{new Date(item.createdAt).toLocaleString()}</Text>{item.source==='feed'&&<Text style={styles.openPost}>Open post ›</Text>}</View></Pressable>)}
    {unread>0&&<Text style={styles.footer}>{unread} unread</Text>}
   </ScrollView>
 </View>
}
const styles=StyleSheet.create({root:{flex:1,backgroundColor:kivoTheme.colors.background},header:{minHeight:78,paddingHorizontal:18,flexDirection:'row',alignItems:'center',borderBottomWidth:1,borderBottomColor:kivoTheme.colors.border},back:{color:kivoTheme.colors.cream,fontSize:38,width:35},eyebrow:{color:kivoTheme.colors.accent,fontSize:9,fontWeight:'800',letterSpacing:1.5},title:{color:kivoTheme.colors.text,fontSize:23,fontWeight:'800',marginTop:2},read:{color:kivoTheme.colors.accent,fontSize:10,fontWeight:'800',marginLeft:'auto'},body:{padding:18,paddingBottom:40},status:{color:kivoTheme.colors.textMuted,fontSize:11,marginBottom:8},card:{backgroundColor:kivoTheme.colors.surface,borderRadius:18,borderWidth:1,borderColor:kivoTheme.colors.border,padding:18},cardTitle:{color:kivoTheme.colors.text,fontWeight:'800'},cardText:{color:kivoTheme.colors.textMuted,fontSize:13,lineHeight:20,marginTop:7},item:{flexDirection:'row',padding:15,borderRadius:16,backgroundColor:kivoTheme.colors.surface,borderWidth:1,borderColor:kivoTheme.colors.border,marginBottom:9},unread:{borderColor:kivoTheme.colors.accent},dot:{width:7,height:7,borderRadius:4,backgroundColor:kivoTheme.colors.accent,marginTop:6,marginRight:11},copy:{flex:1},itemTitle:{color:kivoTheme.colors.text,fontSize:13,fontWeight:'800'},itemBody:{color:kivoTheme.colors.textMuted,fontSize:11.5,lineHeight:17,marginTop:4},time:{color:kivoTheme.colors.textMuted,fontSize:9,marginTop:7},openPost:{color:kivoTheme.colors.accent,fontSize:10,fontWeight:'800',marginTop:7},footer:{color:kivoTheme.colors.textMuted,textAlign:'center',fontSize:10,marginTop:8}});
