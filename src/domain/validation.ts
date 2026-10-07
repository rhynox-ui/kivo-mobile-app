export function isNonEmpty(value:string):boolean{return value.trim().length>0;}
export function isWalletAddress(value:string):boolean{return /^0x[a-fA-F0-9]{40}$/.test(value);}
