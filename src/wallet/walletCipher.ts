import {pbkdf2Async} from '@noble/hashes/pbkdf2.js';
import {sha256} from '@noble/hashes/sha2.js';
import {gcm} from '@noble/ciphers/aes.js';

export const PBKDF2_ITERATIONS=600_000;
export type SecretRecord={iterations:number;salt:string;iv:string;ciphertext:string};
const b64=(b:Uint8Array)=>Buffer.from(b).toString('base64');
const unb64=(s:string)=>new Uint8Array(Buffer.from(s,'base64'));
export async function encryptSecret(secret:string,password:string):Promise<SecretRecord>{
 const salt=crypto.getRandomValues(new Uint8Array(16)); const iv=crypto.getRandomValues(new Uint8Array(12));
 const key=await pbkdf2Async(sha256,new TextEncoder().encode(password),salt,{c:PBKDF2_ITERATIONS,dkLen:32});
 return {iterations:PBKDF2_ITERATIONS,salt:b64(salt),iv:b64(iv),ciphertext:b64(gcm(key,iv).encrypt(new TextEncoder().encode(secret)))};
}
export async function decryptSecret(record:SecretRecord,password:string):Promise<string>{
 if(!record||record.iterations<50_000||record.iterations>5_000_000) throw new Error('Incorrect password.');
 const key=await pbkdf2Async(sha256,new TextEncoder().encode(password),unb64(record.salt),{c:record.iterations,dkLen:32});
 try{return new TextDecoder().decode(gcm(key,unb64(record.iv)).decrypt(unb64(record.ciphertext)));}catch{throw new Error('Incorrect password.');}
}