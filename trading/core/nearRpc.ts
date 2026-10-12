// src/core/nearRpc.ts
//
// Read-only NEAR RPC — a TypeScript port of the site's src/nearRpc.js
// (mango-bridge.jsx), same endpoints and the same rule: try each public
// node in turn, but never retry a real contract/account error on another
// node (it would be the same everywhere). No keys, no signing here.

export const NEAR_RPCS = ['https://rpc.mainnet.fastnear.com', 'https://near.lava.build', 'https://rpc.mainnet.near.org'];

type RpcError = Error & {nearError?: unknown};

/** One JSON-RPC call, falling through the endpoints. Throws the last error if all fail. */
export async function nearRpc<T = any>(method: string, params: unknown, rpcs: string[] = NEAR_RPCS, fetchImpl: typeof fetch = fetch): Promise<T> {
  let lastError: Error = new Error("Couldn't reach NEAR.");
  for (const url of rpcs) {
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({jsonrpc: '2.0', id: 'mango', method, params}),
      });
      const body = (await res.json()) as {result?: unknown; error?: {cause?: {name?: string}; data?: string; message?: string}};
      if (body?.error) {
        const err: RpcError = new Error(body.error?.cause?.name || body.error?.data || body.error?.message || 'NEAR RPC error');
        err.nearError = body.error;
        throw err;
      }
      return body.result as T;
    } catch (err) {
      if ((err as RpcError)?.nearError) throw err;
      lastError = err as Error;
    }
  }
  throw lastError;
}

function encodeArgs(args: unknown): string {
  return Buffer.from(JSON.stringify(args ?? {}), 'utf8').toString('base64');
}

/** Calls a view method and JSON-decodes its result. */
export async function nearView<T = any>(contractId: string, methodName: string, args: unknown = {}, rpcs: string[] = NEAR_RPCS, fetchImpl: typeof fetch = fetch): Promise<T> {
  const result = await nearRpc<{result: number[]; error?: string}>(
    'query',
    {request_type: 'call_function', finality: 'final', account_id: contractId, method_name: methodName, args_base64: encodeArgs(args)},
    rpcs,
    fetchImpl,
  );
  if (result?.error) throw new Error(result.error);
  const text = Buffer.from(Uint8Array.from(result.result)).toString('utf8');
  return (text ? JSON.parse(text) : null) as T;
}
