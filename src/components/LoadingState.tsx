import React from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { kivoTheme } from '../theme/kivoTheme';

export function LoadingState({ label = 'Loading Kivo…' }: { label?: string }) { return <View style={styles.root}><ActivityIndicator color={kivoTheme.colors.accent}/><Text style={styles.text}>{label}</Text></View>; }
const styles=StyleSheet.create({root:{padding:28,alignItems:'center',justifyContent:'center'},text:{color:kivoTheme.colors.textMuted,fontSize:13,marginTop:10}});
