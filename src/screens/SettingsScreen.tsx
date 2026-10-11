import React from 'react';
import { Linking, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { kivoAlert } from '../components/KivoAlert';
import { kivoTheme } from '../theme/kivoTheme';
import { updateSettings, useSettings } from '../state/settingsStore';
import { getTradeHistory } from '@kivo/trading/kivo/history';
import { AppearanceHapticsScreen } from './AppearanceHapticsScreen';

type SettingsItem = {
  label: string;
  icon: string;
  value?: string;
  destructive?: boolean;
  action: 'wallet' | 'profile' | 'haptics' | 'notifications' | 'autoMove' | 'language' | 'security' | 'legal' | 'taxes' | 'help' | 'docs' | 'x' | 'telegram' | 'logout' | 'delete';
};

export function SettingsScreen({ onBack, onOpenWallet, onOpenProfile, onOpenSecurity, onLogout }: { onBack:()=>void; onOpenWallet?:()=>void; onOpenProfile?:()=>void; onOpenSecurity?:()=>void; onLogout?:()=>void }) {
  const settings = useSettings();
  const [showAppearance, setShowAppearance] = React.useState(false);
  const items: SettingsItem[] = [
    { label:'Profile and Account',icon:'♙',action:'profile' },
    { label:'Appearance and Haptics',icon:'◐',value:settings.haptics?'On':'Off',action:'haptics' },
    { label:'Language',icon:'◎',value:settings.language,action:'language' },
    { label:'Notifications',icon:'♧',value:settings.notifications?'On':'Off',action:'notifications' },
    { label:'Keep cash on Base',icon:'⇄',value:settings.autoMoveToBase?'On':'Off',action:'autoMove' },
    { label:'Security',icon:'♢',action:'security' },
    { label:'Deposit and Withdraw',icon:'♜',action:'wallet' },
    { label:'Legal and Privacy',icon:'⚖',action:'legal' },
    { label:'Taxes',icon:'▤',action:'taxes' },
    { label:'Help and Support',icon:'?',action:'help' },
    { label:'Documentation',icon:'▥',action:'docs' },
    { label:'X',icon:'𝕏',action:'x' },
    { label:'Telegram',icon:'➤',action:'telegram' },
    { label:'Log Out',icon:'↪',destructive:true,action:'logout' },
    { label:'Delete Account',icon:'!',destructive:true,action:'delete' },
  ];

  const handlePress=(item:SettingsItem)=>{
    switch(item.action){
      case 'wallet': onOpenWallet?.(); return;
      case 'profile': onOpenProfile?.(); return;
      case 'haptics': setShowAppearance(true); return;
      case 'autoMove': updateSettings({autoMoveToBase:!settings.autoMoveToBase}); return;
      case 'notifications':
        updateSettings({notifications:!settings.notifications});
        Linking.openSettings().catch(()=>{});
        return;
      case 'language': updateSettings({language:settings.language==='System'?'English':'System'}); return;
      case 'security': onOpenSecurity?.(); return;
      case 'legal': Linking.openURL('https://kivo-web.pages.dev/docs/').catch(()=>kivoAlert('Legal and Privacy','Unable to open Kivo documentation right now.')); return;
      case 'taxes': {
        const rows = getTradeHistory();
        if (!rows.length) { kivoAlert('Taxes','No signed trades are recorded on this device yet.'); return; }
        const csv = ['Date,Side,Chain,Pay,Receive,Status,Transaction hash', ...rows.map(r => [new Date(r.createdAt).toISOString(),r.side,r.token.chainKey,`${r.pay.amount} ${r.pay.symbol}`,`${r.receive.amount ?? ''} ${r.receive.symbol}`,r.status,r.txHashes[0] ?? ''].map(v => `"${String(v).replace(/"/g,'""')}"`).join(','))].join('\\n');
        Share.share({message:csv,title:'Kivo trade history.csv'}).catch(()=>{});
        return;
      }
      case 'help': Linking.openURL('mailto:support@kivotrade.site?subject=Kivo%20Support').catch(()=>kivoAlert('Help and Support','Unable to open your email app right now.')); return;
      case 'docs': Linking.openURL('https://kivo-web.pages.dev/docs/').catch(()=>kivoAlert('Documentation','Unable to open documentation right now.')); return;
      case 'x': Linking.openURL('https://x.com/Kivotrade').catch(()=>kivoAlert('Kivo on X','Unable to open X right now.')); return;
      case 'telegram': Linking.openURL('https://t.me/Kivotrade').catch(()=>kivoAlert('Kivo Telegram','Unable to open Telegram right now.')); return;
      case 'logout':
        kivoAlert('Log out','End the current Kivo session on this device?',[
          {text:'Cancel',style:'cancel'},
          {text:'Log Out',style:'destructive',onPress:()=>onLogout?.()},
        ]); return;
      case 'delete':
        kivoAlert('Delete account','This permanently removes the local Kivo session after confirmation. Production account deletion must also be authorized by the backend.',[
          {text:'Cancel',style:'cancel'},
          {text:'Delete',style:'destructive',onPress:()=>onLogout?.()},
        ]); return;
    }
  };

  if (showAppearance) return <AppearanceHapticsScreen onBack={() => setShowAppearance(false)} />;

  return <View style={styles.root}><ScrollView contentContainerStyle={styles.content}>
    <View style={styles.header}><Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={onBack} hitSlop={10}><Text style={styles.back}>‹</Text></Pressable><Text style={styles.title}>Settings</Text></View>
    <View style={styles.list}>{items.map((item,index)=><Pressable key={item.label} accessibilityRole="button" onPress={()=>handlePress(item)} style={[styles.row,index===items.length-1&&styles.lastRow]}>
      <View style={[styles.icon,item.destructive&&styles.dangerIcon]}><Text style={[styles.iconText,item.destructive&&styles.dangerText]}>{item.icon}</Text></View>
      <Text style={[styles.name,item.destructive&&styles.dangerText]}>{item.label}</Text>
      {item.value?<Text style={styles.value}>{item.value}</Text>:null}
      <Text style={[styles.arrow,item.destructive&&styles.dangerText]}>›</Text>
    </Pressable>)}</View>
    <Text style={styles.footer}>Kivo • Chat • Connect • Trade</Text>
  </ScrollView></View>
}
const styles=StyleSheet.create({root:{flex:1,backgroundColor:kivoTheme.colors.background},content:{paddingHorizontal:20,paddingTop:16,paddingBottom:40},header:{flexDirection:'row',alignItems:'center',marginBottom:18},back:{color:kivoTheme.colors.cream,fontSize:38,width:38,lineHeight:42},title:{color:kivoTheme.colors.text,fontSize:34,fontWeight:'800'},list:{borderTopWidth:1,borderTopColor:kivoTheme.colors.border},row:{minHeight:68,borderBottomWidth:1,borderBottomColor:kivoTheme.colors.border,flexDirection:'row',alignItems:'center',paddingVertical:8},lastRow:{borderBottomWidth:0},icon:{width:40,alignItems:'center',justifyContent:'center',marginRight:10},iconText:{color:kivoTheme.colors.cream,fontSize:24,fontWeight:'400'},dangerIcon:{borderRadius:14},dangerText:{color:'#E0443E'},name:{flex:1,color:kivoTheme.colors.text,fontSize:16,fontWeight:'600'},value:{color:kivoTheme.colors.textMuted,fontSize:14,marginRight:12},arrow:{color:kivoTheme.colors.textMuted,fontSize:28,width:18,textAlign:'right'},footer:{color:kivoTheme.colors.textMuted,textAlign:'center',fontSize:11,marginTop:26}});