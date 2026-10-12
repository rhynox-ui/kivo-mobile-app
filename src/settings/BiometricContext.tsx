import {createContext,useContext} from 'react';
type V={biometricAvailable:boolean;biometricEnabled:boolean;biometryLabel:string;setBiometricEnabled:(v:boolean)=>void;appLockEnabled:boolean;setAppLockEnabled:(v:boolean)=>void};
export const BiometricContext=createContext<V|null>(null);
export function useBiometric(){const v=useContext(BiometricContext);if(!v)throw new Error('useBiometric must be used within BiometricContext');return v;}