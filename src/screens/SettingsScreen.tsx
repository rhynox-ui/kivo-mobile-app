import React from 'react';
import { Linking, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { kivoAlert } from '../components/KivoAlert';
import { kivoTheme } from '../theme/kivoTheme';
import { updateSettings, useSettings } from '../state/settingsStore';
import { getTradeHistory } from '@kivo/trading/kivo/history';
import { AppearanceHapticsScreen } from './AppearanceHapticsScreen';
import { api } from '../state/session';

type SettingsItem = {
  label: string;
  icon: string;
  value?: string;
  destructive?: boolean;
  action: 'wallet' | 'rewards' | 'profile' | 'haptics' | 'notifications' | 'language' | 'security' | 'legal' | 'taxes' | 'help' | 'docs' | 'x' | 'telegram' | 'logout' | 'delete';
};

export function SettingsScreen({ onBack, onOpenWallet, onOpenRewards, onOpenProfile, onOpenSecurity, onLogout }: { onBack:()=>void; onOpenWallet?:()=>void; onOpenRewards?:()=>void; onOpenProfile?:()=>void; onOpenSecurity?:()=>void; onLogout?:()=>void }) {
  const settings = useSettings();
  const [showAppearance, setShowAppearance] = React.useState(false);
  const [deletion, setDeletion] = React.useState<{status: 'pending' | 'processing'; executeAt: number} | null>(null);
  React.useEffect(() => { let active = true; api.accountDeletionStatus().then(result => { if (active && result.pending && result.status && result.executeAt) setDeletion({status: result.status, executeAt: result.executeAt}); }).catch(() => {}); return () => { active = false; }; }, []);
  const items: SettingsItem[] = [
    { label:'Profile and Account',icon:'♙',action:'profile' },
    { label:'Rewards',icon:'🎁',value:'Who referred you?',action:'rewards' },
    { label:'Appearance and Haptics',icon:'◐',value:settings.haptics?'On':'Off',action:'haptics' },
    { label:'Language',icon:'◎',value:settings.language,action:'language' },
    { label:'Notifications',icon:'♧',value:settings.notifications?'On':'Off',action:'notifications' },
    { label:'Security',icon:'♢',action:'security' },
    { label:'Deposit and Withdraw',icon:'♜',action:'wallet' },
    { label:'Legal and Privacy',icon:'⚖',action:'legal' },
    { label:'Taxes',icon:'▤',action:'taxes' },
    { label:'Help and Support',icon:'?',action:'help' },
    { label:'Documentation',icon:'▥',action:'docs' },
    { label:'X',icon:'𝕏',action:'x' },
    { label:'Telegram',icon:'➤',action:'telegram' },
    { label:'Log Out',icon:'↪',destructive:true,action:'logout' },
    { label:deletion?.status==='pending'?'Cancel Account Deletion':deletion?.status==='processing'?'Deletion In Progress':'Delete Account',icon:'!',destructive:true,action:'delete' },
  ];

  const handlePress=(item:SettingsItem)=>{
    switch(item.action){
      case 'wallet': onOpenWallet?.(); return;
      case 'rewards': onOpenRewards?.(); return;
      case 'profile': onOpenProfile?.(); return;
      case 'haptics': setShowAppearance(true); return;
      case 'notifications':
        updateSettings({notifications:!settings.notifications});
        Linking.openSettings().catch(()=>{});
        return;
      case 'language': updateSettings({language:settings.language==='System'?'English':'System'}); return;
      case 'security': onOpenSecurity?.(); return;
      case 'legal':
        kivoAlert('Legal and Privacy','Choose which Kivo document to open.',[
          {text:'Privacy Policy',onPress:()=>{void Linking.openURL('https://kivotrade.site/privacy.html').catch(()=>kivoAlert('Privacy Policy','Unable to open the privacy policy right now.'));}},
          {text:'Terms of Service',onPress:()=>{void Linking.openURL('https://kivotrade.site/terms.html').catch(()=>kivoAlert('Terms of Service','Unable to open the terms right now.'));}},
          {text:'Account Deletion Help',onPress:()=>{void Linking.openURL('mailto:support@kivotrade.site?subject=Kivo%20account%20deletion%20request').catch(()=>kivoAlert('Account Deletion Help','Email support@kivotrade.site to request account deletion outside the app.'));}},
          {text:'Cancel',style:'cancel'},
        ]); return;
      case 'taxes': {
        const rows = getTradeHistory();
        if (!rows.length) { kivoAlert('Taxes','No signed trades are recorded on this device yet.'); return; }
        const csv = ['Date,Side,Chain,Pay,Receive,Status,Transaction hash', ...rows.map(r => [new Date(r.createdAt).toISOString(),r.side,r.token.chainKey,`${r.pay.amount} ${r.pay.symbol}`,`${r.receive.amount ?? ''} ${r.receive.symbol}`,r.status,r.txHashes[0] ?? ''].map(v => `"${String(v).replace(/"/g,'""')}"`).join(','))].join('\\n');
        Share.share({message:csv,title:'Kivo trade history.csv'}).catch(()=>{});
        return;
      }
      case 'help': Linking.openURL('mailto:support@kivotrade.site?subject=Kivo%20Support').catch(()=>kivoAlert('Help and Support','Unable to open your email app right now.')); return;
      case 'docs': Linking.openURL('https://kivotrade.site/docs/').catch(()=>kivoAlert('Documentation','Unable to open documentation right now.')); return;
      case 'x': Linking.openURL('https://x.com/Kivotrade').catch(()=>kivoAlert('Kivo on X','Unable to open X right now.')); return;
      case 'telegram': Linking.openURL('https://t.me/Kivotrade').catch(()=>kivoAlert('Kivo Telegram','Unable to open Telegram right now.')); return;
      case 'logout':
        kivoAlert('Log out','End the current Kivo session on this device?',[
          {text:'Cancel',style:'cancel'},
          {text:'Log Out',style:'destructive',onPress:()=>onLogout?.()},
        ]); return;
      case 'delete':
        if (deletion?.status === 'processing') {
          kivoAlert('Deletion in progress','Kivo has started permanently deleting this account. It can no longer be cancelled from the app. Contact support@kivotrade.site if you believe this is a mistake.');
          return;
        }
        if (deletion?.status === 'pending') {
          const date = new Date(deletion.executeAt).toLocaleString();
          kivoAlert('Cancel account deletion',`Your account is scheduled for permanent deletion at ${date}. Cancel the request and keep your account?`,[
            {text:'Keep deletion scheduled',style:'cancel'},
            {text:'Cancel Deletion',onPress:()=>{void api.cancelAccountDeletion().then(()=>{setDeletion(null);kivoAlert('Deletion cancelled','Your Kivo account will remain active.');}).catch(error=>kivoAlert('Could not cancel deletion',error instanceof Error?error.message:'Please try again.'));}},
          ]);
          return;
        }
        kivoAlert('Delete account?','Your account will be permanently deleted 24 hours after you confirm. Kivo will delete your profile, social connections, Kivo-hosted messages and media, and communities you own. This cannot be undone after deletion starts.\n\nWallet warning: deleting Kivo does NOT move, refund, or recover funds or tokens. On-chain transactions cannot be reversed. Save your recovery phrase securely and move any assets you want to keep before confirming. Some payment records may be retained where legally required.\n\nYou can cancel this request in Settings during the 24-hour grace period. After the 24-hour grace period, deletion runs automatically (it may take a few minutes); you do not need to return to confirm it.',[
          {text:'Keep Account',style:'cancel'},
          {text:'Schedule Deletion',style:'destructive',onPress:()=>{void api.requestAccountDeletion().then(result=>{setDeletion({status:'pending',executeAt:result.executeAt});kivoAlert('Deletion scheduled',`Your account is scheduled for deletion after the 24-hour grace period, at ${new Date(result.executeAt).toLocaleString()}. You can cancel it from Settings before processing begins.`);}).catch(error=>kivoAlert('Could not schedule deletion',error instanceof Error?error.message:'Please try again.'));}},
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