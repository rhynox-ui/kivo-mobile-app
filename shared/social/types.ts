export type KivoAddress = string;
export type UserId = string;
export type GroupId = string;

export type KivoUser = { id: UserId; username: string; walletAddress: KivoAddress; avatarUri?: string };
export type KivoMessage = { id: string; conversationId: string; senderId: UserId; text: string; createdAt: number };
export type KivoGroup = { id: GroupId; name: string; description?: string; ownerId: UserId; adminIds: UserId[]; memberCount: number; visibility?: 'public' | 'private' };
export type TokenRef = { chainId: string; address: string; symbol: string; decimals: number };