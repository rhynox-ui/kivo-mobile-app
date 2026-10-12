import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { kivoTheme } from '../theme/kivoTheme';

export function EmptyState({ title, message }: { title: string; message: string }) {
  return <View style={styles.root}><Text style={styles.title}>{title}</Text><Text style={styles.message}>{message}</Text></View>;
}
const styles=StyleSheet.create({root:{padding:28,alignItems:'center',justifyContent:'center'},title:{color:kivoTheme.colors.text,fontSize:17,fontWeight:'800',textAlign:'center'},message:{color:kivoTheme.colors.textMuted,fontSize:13,lineHeight:20,textAlign:'center',marginTop:7,maxWidth:300}});
