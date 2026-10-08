import AsyncStorage from '@react-native-async-storage/async-storage';
const KEY='kivo_unlock_attempts_v1'; const FREE=5; const DUR=[30000,60000,120000,300000,900000];
type State={failCount:number;lockedUntil:number};
async function load():Promise<State>{try{const r=await AsyncStorage.getItem(KEY);if(!r)return{failCount:0,lockedUntil:0};const x=JSON.parse(r);return{failCount:Number.isFinite(x.failCount)?x.failCount:0,lockedUntil:Number.isFinite(x.lockedUntil)?x.lockedUntil:0};}catch{return{failCount:0,lockedUntil:0};}}
async function save(s:State){try{await AsyncStorage.setItem(KEY,JSON.stringify(s));}catch{}}
export async function getLockoutStatus(){const s=await load();const left=s.lockedUntil-Date.now();return{locked:left>0,remainingMs:Math.max(0,left)};}
export async function recordFailedAttempt(){const s=await load();const n=s.failCount+1;let until=s.lockedUntil;if(n>FREE)until=Date.now()+DUR[Math.min(n-FREE-1,DUR.length-1)];await save({failCount:n,lockedUntil:until});return{locked:until>Date.now(),remainingMs:Math.max(0,until-Date.now())};}
export async function recordSuccessfulUnlock(){await save({failCount:0,lockedUntil:0});}