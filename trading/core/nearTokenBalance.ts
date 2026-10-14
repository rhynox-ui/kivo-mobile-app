export type NearViewReader = (
  contractId: string,
  method: string,
  args?: unknown,
) => Promise<unknown>;

/** Read a NEP-141 token balance without converting a failed response into a nonzero balance. */
export async function readNearTokenBalance(
  tokenId: string,
  accountId: string,
  view: NearViewReader,
): Promise<bigint> {
  const raw = await view(tokenId, 'ft_balance_of', {account_id: accountId});
  return typeof raw === 'string' && /^\d+$/.test(raw) ? BigInt(raw) : 0n;
}
