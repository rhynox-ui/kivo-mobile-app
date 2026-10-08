import AsyncStorage from '@react-native-async-storage/async-storage';
const KEY='kivo_auto_lock_ms_v1';
export const DEFAULT_AUTO_LOCK_MS=5*60_000;
export const AUTO_LOCK_OPTIONS=[{label:'Immediately',ms:0},{label:'30 seconds',ms:30000},{label:'1 minute',ms:60000},{label:'5 minutes',ms:5*60_000},{label:'15 minutes',ms:15*60_000}];
export async function loadAutoLockMs(){try{const r=await AsyncStorage.getItem(KEY);if(r===null)return DEFAULT_AUTO_LOCK_MS;const n=Number(r);return Number.isFinite(n)&&n>=0?n:DEFAULT_AUTO_LOCK_MS;}catch{return DEFAULT_AUTO_LOCK_MS;}}
export async function setAutoLockMs(ms:number){await AsyncStorage.setItem(KEY,String(ms));}