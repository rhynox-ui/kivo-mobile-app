import {createContext,useContext} from 'react';
type V={autoLockMs:number;setAutoLockMs:(ms:number)=>void};
export const AutoLockContext=createContext<V|null>(null);
export function useAutoLock(){const v=useContext(AutoLockContext);if(!v)throw new Error('useAutoLock must be used within AutoLockContext');return v;}