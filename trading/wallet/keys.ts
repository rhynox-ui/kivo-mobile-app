// The account shape Mango Pro's execution code expects. In Kivo it is built
// only inside a device-unlock callback and never stored.
export type ChainAccount = {address: string; privateKey: string};
export type AuthMethod = 'seed' | 'google';
export type DerivedAccounts = {evm: ChainAccount; solana: ChainAccount; authMethod?: AuthMethod};
