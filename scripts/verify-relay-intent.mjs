import assert from 'node:assert/strict';
import { buildTransactionIntent, assertQuoteMatchesIntent, TransactionIntentError } from '../trading/core/txIntentFirewall.ts';

const intent = buildTransactionIntent({
  originChainId: 8453,
  destinationChainId: 792703809,
  originCurrency: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  destinationCurrency: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  amountBaseUnits: '1000000',
  userAddress: '0x9858effd232b4033e47d90003d41ec34ecaeda94',
  recipientAddress: '11111111111111111111111111111111',
});

const details = {
  recipient: '11111111111111111111111111111111',
  currencyIn: {currency: {chainId: 8453, address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'}, amount: '1000000'},
  currencyOut: {currency: {chainId: 792703809, address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'}, amount: '900000'},
};

assert.doesNotThrow(() => assertQuoteMatchesIntent({details}, intent));
const rejects = (quote, message) => assert.throws(() => assertQuoteMatchesIntent(quote, intent), TransactionIntentError, message);
rejects(null, 'missing quote');
rejects({details: {}}, 'missing currency metadata');
rejects({details: {...details, currencyIn: {currency: {address: details.currencyIn.currency.address}, amount: '1000000'}}}, 'missing source chain');
rejects({details: {...details, currencyOut: {currency: {chainId: 1, address: details.currencyOut.currency.address}, amount: '900000'}}}, 'wrong destination chain');
rejects({details: {...details, currencyIn: {currency: {chainId: 8453, address: '0x0000000000000000000000000000000000000001'}, amount: '1000000'}}}, 'wrong source token');
rejects({details: {...details, currencyOut: {currency: {chainId: 792703809, address: 'EPjFWdd5AUfqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'}, amount: '900000'}}}, 'wrong Solana token casing/address');
rejects({details: {...details, recipient: undefined}}, 'missing recipient');
rejects({details: {...details, recipient: '11111111111111111111111111111112'}}, 'wrong recipient');
rejects({details: {...details, currencyIn: {currency: details.currencyIn.currency, amount: 'not-a-number'}}}, 'malformed source amount');
rejects({details: {...details, currencyIn: {currency: details.currencyIn.currency, amount: '1000001'}}}, 'overspend');
assert.throws(() => buildTransactionIntent({
  originChainId: 8453, destinationChainId: 792703809, originCurrency: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  destinationCurrency: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', amountBaseUnits: 'bad',
  userAddress: '0x9858effd232b4033e47d90003d41ec34ecaeda94',
}), TransactionIntentError);

console.log('Relay intent regression checks passed: incomplete metadata, wrong chain/token/recipient, malformed amounts, and overspend all fail closed.');
