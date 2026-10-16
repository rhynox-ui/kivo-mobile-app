import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { validateMnemonic } from '@scure/bip39';
import { wordlist as english } from '@scure/bip39/wordlists/english.js';
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { deriveSolanaKeypair } from '../wallet/solanaKeys';
import { kivoTheme } from '../theme/kivoTheme';

type Preview = { kind: string; status: string; addresses: { network: string; address: string }[]; networks: string[] };
function inspectLocally(raw: string): Preview {
  const value = raw.trim();
  if (!value) return { kind: 'Waiting for input', status: 'Enter a phrase or private key to preview its format.', addresses: [], networks: [] };
  const words = value.toLowerCase().split(/\\s+/).filter(Boolean);
  if ((words.length === 12 || words.length === 24) && validateMnemonic(words.join(' '), english)) {
    const phrase = words.join(' ');
    const addresses: Preview['addresses'] = [];
    try { addresses.push({ network: 'EVM address', address: mnemonicToAccount(phrase).address }); } catch {}
    try { addresses.push({ network: 'Solana address', address: deriveSolanaKeypair(phrase).publicKey.toBase58() }); } catch {}
    return { kind: 'Recovery phrase', status: 'Valid BIP-39 format. Preview is derived locally; nothing is imported or saved.', addresses, networks: ['EVM networks', 'Solana', 'NEAR derivation'] };
  }
  const evmKey = value.startsWith('0x') ? value : '0x' + value;
  if (/^0x[0-9a-fA-F]{64}$/.test(evmKey)) {
    try { return { kind: 'EVM private key', status: 'Format recognized. Preview only; wallet is not imported or saved.', addresses: [{ network: 'EVM address', address: privateKeyToAccount(evmKey as Hex).address }], networks: ['EVM networks'] }; } catch {}
  }
  try {
    const bytes = bs58.decode(value);
    if (bytes.length === 64) {
      const pair = Keypair.fromSecretKey(bytes);
      return { kind: 'Solana private key', status: 'Format recognized. Preview only; wallet is not imported or saved.', addresses: [{ network: 'Solana address', address: pair.publicKey.toBase58() }], networks: ['Solana'] };
    }
  } catch {}
  return { kind: 'Unrecognized format', status: 'Supported previews: valid 12/24-word BIP-39 phrase, 32-byte EVM private key, or 64-byte base58 Solana secret key.', addresses: [], networks: [] };
}
export function ImportWalletScreen({ onBack }: { onBack: () => void }) {
  const [value, setValue] = useState('');
  const [visible, setVisible] = useState(false);
  const preview = useMemo(() => inspectLocally(value), [value]);
  return <ScrollView style={s.root} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
    <View style={s.header}><Pressable onPress={onBack}><Text style={s.back}>‹</Text></Pressable><Text style={s.title}>Import wallet</Text></View>
    <View style={s.notice}><Text style={s.noticeTitle}>Concept preview only</Text><Text style={s.body}>This screen does not import, store, or activate a wallet. Format detection and address preview run locally on this device.</Text></View>
    <Text style={s.label}>Recovery phrase or private key</Text>
    <TextInput value={value} onChangeText={setValue} placeholder="Paste phrase or private key" placeholderTextColor={kivoTheme.colors.textMuted} autoCapitalize="none" autoCorrect={false} spellCheck={false} autoComplete="off" importantForAutofill="no" textContentType="none" multiline secureTextEntry={!visible} style={s.input} accessibilityLabel="Recovery phrase or private key" />
    <View style={s.actions}><Pressable onPress={() => setVisible(v => !v)} style={s.smallButton}><Text style={s.smallText}>{visible ? 'Hide input' : 'Show input'}</Text></Pressable><Pressable onPress={() => { setValue(''); setVisible(false); }} style={s.smallButton}><Text style={s.smallText}>Clear</Text></Pressable></View>
    <View style={s.card}><Text style={s.label}>Detected format</Text><Text style={s.detected}>{preview.kind}</Text><Text style={s.body}>{preview.status}</Text>
      {preview.addresses.map(a => <View key={a.network} style={s.addressRow}><Text style={s.network}>{a.network}</Text><Text selectable style={s.address}>{a.address}</Text></View>)}
      {preview.networks.length > 0 && <><Text style={[s.label, { marginTop: 16 }]}>Network compatibility</Text><View style={s.chips}>{preview.networks.map(n => <View key={n} style={s.chip}><Text style={s.chipText}>{n}</Text></View>)}</View></>}
    </View>
    <Text style={s.footer}>Never share recovery details. Input is not sent to a backend or written to logs or secure storage.</Text>
    <Pressable onPress={onBack} style={s.button}><Text style={s.buttonText}>Back</Text></Pressable>
  </ScrollView>;
}
const s = StyleSheet.create({
 root:{flex:1,backgroundColor:kivoTheme.colors.background},content:{padding:24,paddingBottom:32,flexGrow:1},header:{flexDirection:'row',alignItems:'center',marginBottom:22},back:{color:kivoTheme.colors.cream,fontSize:38,width:35},title:{color:kivoTheme.colors.text,fontSize:22,fontWeight:'800'},
 notice:{backgroundColor:kivoTheme.colors.surfaceRaised,borderWidth:1,borderColor:kivoTheme.colors.border,borderRadius:14,padding:14,marginBottom:20},noticeTitle:{color:kivoTheme.colors.cream,fontSize:13,fontWeight:'800',marginBottom:5},label:{color:kivoTheme.colors.text,fontSize:13,fontWeight:'700',marginBottom:8},body:{color:kivoTheme.colors.textMuted,fontSize:12,lineHeight:18},
 input:{minHeight:126,borderWidth:1,borderColor:kivoTheme.colors.border,borderRadius:16,backgroundColor:kivoTheme.colors.surface,color:kivoTheme.colors.text,padding:16,textAlignVertical:'top',fontSize:14},actions:{flexDirection:'row',justifyContent:'flex-end',gap:10,marginTop:8,marginBottom:18},smallButton:{paddingHorizontal:12,paddingVertical:8,borderRadius:10,backgroundColor:kivoTheme.colors.surfaceRaised},smallText:{color:kivoTheme.colors.textMuted,fontSize:12,fontWeight:'700'},
 card:{borderWidth:1,borderColor:kivoTheme.colors.border,borderRadius:16,backgroundColor:kivoTheme.colors.surface,padding:16},detected:{color:kivoTheme.colors.cream,fontSize:18,fontWeight:'800',marginBottom:6},addressRow:{borderTopWidth:1,borderTopColor:kivoTheme.colors.border,paddingTop:10,marginTop:10},network:{color:kivoTheme.colors.text,fontSize:12,fontWeight:'700',marginBottom:4},address:{color:kivoTheme.colors.textMuted,fontSize:11,lineHeight:16},chips:{flexDirection:'row',flexWrap:'wrap',gap:7},chip:{backgroundColor:kivoTheme.colors.surfaceRaised,borderRadius:999,paddingHorizontal:10,paddingVertical:6},chipText:{color:kivoTheme.colors.text,fontSize:11,fontWeight:'700'},footer:{color:kivoTheme.colors.textMuted,fontSize:11,lineHeight:16,paddingVertical:16},button:{height:54,borderRadius:27,backgroundColor:kivoTheme.colors.cream,alignItems:'center',justifyContent:'center',marginTop:'auto'},buttonText:{color:kivoTheme.colors.backgroundDeep,fontWeight:'800'}
});