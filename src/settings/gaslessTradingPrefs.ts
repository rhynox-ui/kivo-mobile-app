import AsyncStorage from '@react-native-async-storage/async-storage';
const KEY='kivo_gasless_trading_enabled_v1';
export async function loadGaslessTradingEnabled(){try{const r=await AsyncStorage.getItem(KEY);return r===null?true:r==='1';}catch{return true;}}
export async function setGaslessTradingEnabled(v:boolean){await AsyncStorage.setItem(KEY,v?'1':'0');}