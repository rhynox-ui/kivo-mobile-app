// scripts/verify-near-signing.mjs
//
// Tests for src/core/nearSigning.ts: the wallet's NEAR account signs
// NEP-366 delegate actions that mango-api's relayer (near-relayer.js)
// accepts — sender is the implicit account, signed with its own key,
// consecutive nonces, short validity — and sends them in order, setting
// up a new account first. RPC and relayer are mocked. Run: npm run verify.

import assert from 'node:assert/strict';
import bs58 from 'bs58';
// @near-js ships borsh 1.x; the root 'borsh' is Solana's 0.7, so use the one @near-js encodes with.
import {deserialize} from '../node_modules/@near-js/transactions/node_modules/borsh/lib/esm/index.js';
import {SCHEMA, encodeDelegateAction} from '@near-js/transactions';
import {PublicKey} from '@near-js/crypto';
import {deriveNearAccount} from '../trading/wallet/keys.ts';
import {deriveSolanaKeypair} from '../src/wallet/solanaKeys.ts';
import {DELEGATE_TTL_BLOCKS, NEAR_BOOTSTRAP_URL, NEAR_RELAY_URL, NearSendError, sendSponsoredNearCalls, signNearDelegates} from '../trading/core/nearSigning.ts';

let checks = 0;
const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const near = deriveNearAccount(PHRASE);
const solana = deriveSolanaKeypair(PHRASE);
const session = {
  evm: {address: '0x9858effd232b4033e47d90003d41ec34ecaeda94', privateKey: '0x' + '1'.repeat(64)},
  solana: {address: solana.publicKey.toBase58(), privateKey: bs58.encode(solana.secretKey)},
  near,
};
const USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const call = (method, receiverId = USDC) => ({receiverId, actions: [{type: 'FunctionCall', params: {methodName: method, args: {receiver_id: 'x.near', amount: '5'}, gas: '30000000000000', deposit: '1'}}]});

function mockRpc({exists = true, existsAfter = 0} = {}) {
  let viewCalls = 0;
  return async (method, params) => {
    if (method === 'block') return {header: {height: 5000}};
    if (params?.request_type === 'view_access_key') return {nonce: 90};
    if (params?.request_type === 'view_account') {
      viewCalls++;
      if (exists || viewCalls > existsAfter) return {amount: '1'};
      const e = new Error('UNKNOWN_ACCOUNT');
      e.nearError = {cause: {name: 'UNKNOWN_ACCOUNT'}};
      throw e;
    }
    throw new Error(`unexpected ${method}`);
  };
}
function mockFetch({failAt = -1} = {}) {
  const posts = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    posts.push({url, body});
    const i = posts.filter(p => p.url === NEAR_RELAY_URL).length - 1;
    if (url === NEAR_RELAY_URL && i === failAt) return {ok: false, status: 400, json: async () => ({error: "Mango doesn't sponsor swap."})};
    return {ok: true, status: 200, json: async () => ({data: url === NEAR_RELAY_URL ? {hash: `H${i}`, status: {SuccessValue: ''}} : {created: true}})};
  };
  return {fetchImpl, posts};
}

const signed = await signNearDelegates(session, [call('ft_transfer'), call('ft_transfer_call')], {rpc: mockRpc()});
const decoded = signed.map(s => deserialize(SCHEMA.SignedDelegate, Buffer.from(s, 'base64')));
for (const sd of decoded) {
  const da = sd.delegateAction;
  assert.equal(da.senderId, session.near.address);
  assert.equal(Buffer.from(da.publicKey.ed25519Key.data).toString('hex'), session.near.address);
  const pk = new PublicKey({keyType: 0, data: Uint8Array.from(da.publicKey.ed25519Key.data)});
  assert.ok(pk.verify(encodeDelegateAction(da), Uint8Array.from(sd.signature.ed25519Signature.data)));
}
console.log('ok', ++checks, "- delegates are from the wallet's implicit NEAR account and verify under its own key (what the relayer requires)");

assert.deepEqual(decoded.map(d => BigInt(d.delegateAction.nonce)), [91n, 92n]);
assert.equal(BigInt(decoded[0].delegateAction.maxBlockHeight), 5000n + DELEGATE_TTL_BLOCKS);
assert.ok(DELEGATE_TTL_BLOCKS < 300n);
console.log('ok', ++checks, "- consecutive nonces, and a validity window inside the relayer's 300-block limit");

const fc = decoded[0].delegateAction.actions[0].functionCall;
assert.equal(decoded[0].delegateAction.receiverId, USDC);
assert.equal(fc.methodName, 'ft_transfer');
assert.equal(BigInt(fc.gas), 30000000000000n);
assert.equal(BigInt(fc.deposit), 1n);
assert.deepEqual(JSON.parse(Buffer.from(fc.args).toString()), {receiver_id: 'x.near', amount: '5'});
console.log('ok', ++checks, '- the call is carried exactly: receiver, method, JSON args, gas, attached deposit');

{
  const {fetchImpl, posts} = mockFetch();
  const out = await sendSponsoredNearCalls(session, [call('ft_transfer'), call('ft_transfer_call')], {rpc: mockRpc(), fetchImpl});
  assert.deepEqual(out.map(o => o.hash), ['H0', 'H1']);
  assert.equal(posts.length, 2);
  assert.ok(posts.every(p => p.url === NEAR_RELAY_URL && typeof p.body.signedDelegate === 'string'));
}
console.log('ok', ++checks, "- existing account: each call goes to Mango's relayer, in order");

{
  const {fetchImpl, posts} = mockFetch();
  await sendSponsoredNearCalls(session, [call('ft_transfer')], {rpc: mockRpc({exists: false, existsAfter: 1}), fetchImpl});
  assert.equal(posts[0].url, NEAR_BOOTSTRAP_URL);
  assert.equal(posts[0].body.accountId, session.near.address);
  assert.equal(posts[1].url, NEAR_RELAY_URL);
}
console.log('ok', ++checks, "- a new account is set up by Mango's relayer before the first send");

{
  const {fetchImpl, posts} = mockFetch({failAt: 1});
  await assert.rejects(
    () => sendSponsoredNearCalls(session, [call('ft_transfer'), call('ft_transfer_call'), call('ft_transfer')], {rpc: mockRpc(), fetchImpl}),
    e => e instanceof NearSendError && /doesn't sponsor/.test(e.message) && e.sent.length === 1 && e.sent[0].hash === 'H0',
  );
  assert.equal(posts.filter(p => p.url === NEAR_RELAY_URL).length, 2);
}
console.log('ok', ++checks, "- a refused call stops the sequence (later calls never sent) and reports what already went through");

await assert.rejects(() => signNearDelegates({evm: session.evm, solana: session.solana}, [call('ft_transfer')], {rpc: mockRpc()}), NearSendError);
await assert.rejects(() => signNearDelegates(session, [{receiverId: USDC, actions: [{type: 'Transfer', params: {deposit: '1'}}]}], {rpc: mockRpc()}), NearSendError);
console.log('ok', ++checks, '- no NEAR account, or a non-call action, is refused before anything is signed');

console.log(`\n${checks} checks passed`);
