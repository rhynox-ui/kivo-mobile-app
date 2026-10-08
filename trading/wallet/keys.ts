// The account shape Mango Pro's execution code expects. In Kivo it is built
// only inside a device-unlock callback and never stored.
export type ChainAccount = {address: string; privateKey: string};
export type AuthMethod = 'seed' | 'google';
export const NEAR_DERIVATION_PATH = "m/44'/397'/0'";
export type DerivedAccounts = {evm: ChainAccount; solana: ChainAccount; near?: ChainAccount; authMethod?: AuthMethod};
export function nearDerivationPathForIndex(index: number): string { return `m/44'/397'/${index}'`; }
