// Checks the Send/withdraw safety rules: recipient address checks, chain
// matching, EVM sponsorship eligibility, blocked destinations, base-unit
// fractions and the "may already be on-chain" error classification.
// Run: node --experimental-strip-types --import ./scripts/ts-extensionless.mjs scripts/verify-send-guards.mjs
import assert from 'node:assert/strict';
import {PublicKey} from '@solana/web3.js';
import {blockedDestinationReason, chainMismatchReason, checkRecipientAddress, evmSponsorReason, fractionOf} from '../trading/kivo/transferGuards.ts';
import {classifyTransferError, markFailedOnChain, markMaybeBroadcast, solanaSubmitDefinitelyRejected} from '../trading/core/broadcastState.ts';
import {receiveWithinTolerance} from '../trading/kivo/cash.ts';

const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const SOL_WALLET = '2ApuoLHkMnhX13w6wnSfnP64sbBAgCABiqfHeFYAamki';

// Address format, live as typed.
assert.deepEqual(checkRecipientAddress(''), {ok: false, problem: null});
assert.equal(checkRecipientAddress(BASE_USDC.toLowerCase()).ok, true);
assert.match(checkRecipientAddress(BASE_USDC.replace('fCD6', 'Fcd6')).problem, /checksum/);
assert.match(checkRecipientAddress('0x1234').problem, /40 hex/);
assert.deepEqual(checkRecipientAddress(` ${SOL_WALLET} `), {ok: true, family: 'solana', address: SOL_WALLET});
const [pda] = PublicKey.findProgramAddressSync([Buffer.from('kivo')], new PublicKey('11111111111111111111111111111111'));
assert.match(checkRecipientAddress(pda.toBase58()).problem, /not a wallet/);
assert.equal(checkRecipientAddress('@alice').ok, false);

// Only assets on the address's chain family.
assert.equal(chainMismatchReason('solana', 'evm'), 'This is a Solana token — paste a Solana wallet address');
assert.match(chainMismatchReason('base', 'solana'), /EVM token/);
assert.equal(chainMismatchReason('base', 'evm'), null);

// EVM sends: USDC of at least 1 only (what Kivo's gas sponsor covers).
assert.equal(evmSponsorReason({chainKey: 'base', address: BASE_USDC.toLowerCase(), kind: 'cash'}, 1), null);
assert.match(evmSponsorReason({chainKey: 'base', address: BASE_USDC, kind: 'cash'}, 0.5), /at least 1 USDC/);
assert.match(evmSponsorReason({chainKey: 'base', address: '0x0000000000000000000000000000000000000000', kind: 'native'}), /USDC only/);
assert.match(evmSponsorReason({chainKey: 'base', address: '0x' + '1'.repeat(40), kind: 'token'}), /USDC only/);
assert.equal(evmSponsorReason({chainKey: 'solana', address: 'So11111111111111111111111111111111111111112', kind: 'native'}), null);

// Destinations that lose funds.
const me = '0x' + 'a'.repeat(40);
assert.match(blockedDestinationReason({to: '0x0000000000000000000000000000000000000000', family: 'evm', ownAddresses: []}), /zero address/);
assert.match(blockedDestinationReason({to: me.toUpperCase().replace('0X', '0x'), family: 'evm', ownAddresses: [me]}), /own wallet/);
assert.match(blockedDestinationReason({to: BASE_USDC.toLowerCase(), family: 'evm', ownAddresses: []}), /token contract/);
assert.match(blockedDestinationReason({to: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', family: 'solana', ownAddresses: []}), /mint/);
assert.equal(blockedDestinationReason({to: SOL_WALLET, family: 'solana', ownAddresses: [me]}), null);

// Max in base units never rounds up.
assert.equal(fractionOf(1_000_001n, 100), 1_000_001n);
assert.equal(fractionOf(1_000_001n, 50), 500_000n);

// After a possible broadcast, never "nothing was sent".
assert.equal(classifyTransferError(new Error('Sponsor refused. No transaction was broadcast.')).state, 'not-sent');
const timedOut = classifyTransferError(markMaybeBroadcast(new Error('not confirmed yet'), {signature: 'sig1'}));
assert.equal(timedOut.state, 'maybe-sent');
assert.equal(timedOut.signature, 'sig1');
const pendingRelay = Object.assign(new Error('Submitted.'), {name: 'RelayGaslessPendingError', requestId: '0xreq'});
assert.deepEqual([classifyTransferError(pendingRelay).state, classifyTransferError(pendingRelay).requestId], ['maybe-sent', '0xreq']);
assert.equal(classifyTransferError(Object.assign(new Error('Relay reported this trade failed'), {kivoPartialTxHashes: ['abc']})).state, 'maybe-sent');
assert.equal(classifyTransferError(Object.assign(new Error('x'), {signature: 'sig2'})).state, 'maybe-sent');
assert.equal(classifyTransferError(Object.assign(new Error('Transaction sig3 failed on-chain: {}'), {signature: 'sig3'})).state, 'failed-on-chain');
assert.equal(classifyTransferError(markFailedOnChain(new Error('Relay failure'), {requestId: 'r'})).state, 'failed-on-chain');
assert.equal(solanaSubmitDefinitelyRejected(new Error('Transaction simulation failed: Blockhash not found')), true);
assert.equal(solanaSubmitDefinitelyRejected(new Error('fetch failed')), false);
assert.equal(solanaSubmitDefinitelyRejected(new Error('This transaction has already been processed')), false);

// Home withdrawal: the executed quote may not deliver less than reviewed minus 1%.
assert.equal(receiveWithinTolerance(10, 9.95), true);
assert.equal(receiveWithinTolerance(10, 9.8), false);
assert.equal(receiveWithinTolerance(10, null), false);

console.log('send guards: ok');
