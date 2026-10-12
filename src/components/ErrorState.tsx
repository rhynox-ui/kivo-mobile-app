import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { kivoTheme } from '../theme/kivoTheme';

export function ErrorState({ title = 'Something went wrong', message, onRetry }: { title?: string; message: string; onRetry?: () => void }) { return <View style={styles.root}><Text style={styles.title}>{title}</Text><Text style={styles.message}>{message}</Text>{onRetry ? <Text accessibilityRole="button" onPress={onRetry} style={styles.retry}>Try again</Text> : null}</View>; }
const styles=StyleSheet.create({root:{padding:28,alignItems:'center'},title:{color:kivoTheme.colors.text,fontSize:17,fontWeight:'800'},message:{color:kivoTheme.colors.textMuted,fontSize:13,textAlign:'center',marginTop:7,lineHeight:20},retry:{color:kivoTheme.colors.accent,fontWeight:'800',marginTop:15}});
