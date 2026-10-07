import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { KivoMark } from '../components/KivoMark';
import { kivoTheme } from '../theme/kivoTheme';

const tabs = ['Chats','Discover','Trade','Profile'] as const;
type Tab = typeof tabs[number];

export function HomeScreen() {
  const [tab, setTab] = useState<Tab>('Chats');
  return (
    <View style={styles.container}>
      <View style={styles.header}><View style={styles.brand}><KivoMark size={30}/><Text style={styles.wordmark}>kivo</Text></View><Text style={styles.search}>⌕</Text></View>
      <View style={styles.content}>
        <Text style={styles.heading}>{tab}</Text>
        {tab === 'Chats' && <><Chat name="Crypto Builders" message="Let's launch tomorrow" time="10:42"/><Chat name="Alpha Community" message="New token discussion" time="09:18"/><Chat name="John" message="You: See you later" time="Yesterday"/></>}
        {tab === 'Discover' && <><Card title="Communities" body="Find people building and trading together."/><Card title="Trending" body="Discover conversations around tokens and ideas."/></>}
        {tab === 'Trade' && <><View style={styles.balance}><Text style={styles.balanceLabel}>Available USDC</Text><Text style={styles.balanceValue}>$2,420.00</Text><Text style={styles.balanceSub}>Across supported wallets</Text></View><Card title="Search a token" body="Find an asset and start a trade."/></>}
        {tab === 'Profile' && <><View style={styles.profile}><KivoMark size={48}/><View><Text style={styles.profileName}>@yourname</Text><Text style={styles.profileAddress}>0x••••••••••••</Text></View></View><Card title="Settings" body="Security, wallet and app preferences."/></>}
      </View>
      <View style={styles.nav}>{tabs.map(item=><Pressable key={item} onPress={()=>setTab(item)} style={styles.navItem}><Text style={[styles.navText,item===tab&&styles.navActive]}>{item}</Text></Pressable>)}</View>
    </View>
  );
}

function Chat({name,message,time}:{name:string;message:string;time:string}){return <View style={styles.chat}><View style={styles.chatAvatar}><KivoMark size={25}/></View><View style={styles.chatCopy}><Text style={styles.chatName}>{name}</Text><Text style={styles.chatMessage}>{message}</Text></View><Text style={styles.time}>{time}</Text></View>}
function Card({title,body}:{title:string;body:string}){return <View style={styles.card}><Text style={styles.cardTitle}>{title}</Text><Text style={styles.cardBody}>{body}</Text></View>}

const styles=StyleSheet.create({
  container:{flex:1,backgroundColor:kivoTheme.colors.background},header:{height:76,paddingHorizontal:20,flexDirection:'row',alignItems:'center',justifyContent:'space-between',borderBottomWidth:1,borderBottomColor:kivoTheme.colors.border},brand:{flexDirection:'row',alignItems:'center',gap:10},wordmark:{color:kivoTheme.colors.cream,fontSize:25,fontWeight:'700'},search:{color:kivoTheme.colors.cream,fontSize:30},content:{flex:1,padding:20},heading:{color:kivoTheme.colors.text,fontSize:28,fontWeight:'700',marginBottom:18},
  chat:{flexDirection:'row',alignItems:'center',paddingVertical:14,borderBottomWidth:1,borderBottomColor:kivoTheme.colors.border},chatAvatar:{width:48,height:48,borderRadius:16,backgroundColor:kivoTheme.colors.surface,alignItems:'center',justifyContent:'center'},chatCopy:{flex:1,marginLeft:12},chatName:{color:kivoTheme.colors.text,fontWeight:'700',fontSize:15},chatMessage:{color:kivoTheme.colors.textMuted,fontSize:13,marginTop:4},time:{color:kivoTheme.colors.textMuted,fontSize:10},
  card:{backgroundColor:kivoTheme.colors.surface,borderRadius:18,borderWidth:1,borderColor:kivoTheme.colors.border,padding:18,marginBottom:12},cardTitle:{color:kivoTheme.colors.text,fontSize:16,fontWeight:'700'},cardBody:{color:kivoTheme.colors.textMuted,fontSize:13,lineHeight:20,marginTop:6},balance:{backgroundColor:kivoTheme.colors.surfaceRaised,borderRadius:22,padding:20,marginBottom:16},balanceLabel:{color:kivoTheme.colors.textMuted,fontSize:12},balanceValue:{color:kivoTheme.colors.cream,fontSize:32,fontWeight:'700',marginTop:6},balanceSub:{color:kivoTheme.colors.accent,fontSize:11,marginTop:5},
  profile:{flexDirection:'row',alignItems:'center',gap:14,marginBottom:20},profileName:{color:kivoTheme.colors.text,fontSize:18,fontWeight:'700'},profileAddress:{color:kivoTheme.colors.textMuted,fontSize:12,marginTop:4},
  nav:{height:76,borderTopWidth:1,borderTopColor:kivoTheme.colors.border,flexDirection:'row',backgroundColor:kivoTheme.colors.backgroundDeep},navItem:{flex:1,alignItems:'center',justifyContent:'center'},navText:{color:kivoTheme.colors.textMuted,fontSize:11},navActive:{color:kivoTheme.colors.accent,fontWeight:'800'}
});
