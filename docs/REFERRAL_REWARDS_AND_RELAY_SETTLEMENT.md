# Kivo Referral Rewards and Relay App Fee Settlement

**Status:** In progress. Referral attribution and Relay actual-fee recording are under review in open pull requests. Weekly settlement planning and automatic on-chain payouts are future work and are **not enabled**.

This shared implementation brief applies to Kivo Web and Kivo Mobile. Keep both clients aligned. The Web backend is the source of truth for referral attribution, fee verification, reward liabilities, and settlement state.

## 1. What we are building

Kivo uses Relay for a substantial part of its trading infrastructure. Relay App Fees accrue to Kivo, while the referral program creates a separate obligation to pay eligible referrers. Relay's aggregate dashboard balance does not identify which referrer earned what.

We are building an auditable system to:
1. Attribute referrals and enforce eligibility rules.
2. Record trades using evidence of actual fees collected for Kivo, never quote estimates.
3. Prevent duplicate rewards when Relay reporting and direct on-chain verification overlap.
4. Keep one shared referral ledger and consistent experience across Web and Mobile.
5. Reconcile Relay fee accrual/claims against treasury records without confusing revenue with referral liabilities.
6. Prepare a weekly, idempotent settlement batch for matured rewards.
7. Eventually claim fees where Relay supports it and distribute rewards automatically, only after claim mechanics, treasury balances, signer protection, and recovery are verified.
8. Keep an audit trail for rewards, fee claims, payout attempts, receipts, deferrals, and reconciliation differences.

## 2. Business rules

- Normal trading fee: **50 bps (0.50%)**.
- Referred trader fee: **45 bps (0.45%)**, a 10% discount from normal.
- Referrer share: **25% of the actual eligible Kivo trading fee collected**.
- Reward maturity: **7 days after the qualifying trade**.
- Referral attribution can be set once, within the first 7 days of account creation, and before any rewarded trade.
- No self-referrals or referral cycles.
- If a referrer deletes their account, the referred trader keeps the discount but new rewards for that referrer stop.
- Blue Star subscription payments are not trading fees and must not generate referral rewards.
- Never calculate rewards from quotes, client-supplied fee values, dashboard totals, or guessed fees.
- Unsupported or unverifiable cases must be deferred or rejected safely.

## 3. Source of truth and responsibilities

### Web backend
Owns the authoritative referral/reward ledger. It authenticates users, validates eligibility, verifies Relay request data server-side, binds the request to the authenticated user's wallet, checks status and trade time, and counts only actual App Fee entries paid to Kivo's configured fee recipient. It also owns settlement state, locks, idempotency, admin controls, and reconciliation.

### Web client
Displays backend referral data and may report a Relay request ID after a trade. Client reports are untrusted signals that trigger server verification; they never prove a fee was paid.

### Mobile app
Uses the same referral rules and backend contract. It may report a Relay request ID independently of direct on-chain reporting so one failed verifier does not suppress the other. Client-side retries are best-effort only; durable retry and settlement correctness belong server-side.

### Shared contract
Web and Mobile use the same fee rates, referral rules, API semantics, reward statuses, and user-facing explanations. Do not build a second reward ledger in the app. Never expose Relay API secrets, treasury keys, signer credentials, or admin tokens in either client.

## 4. Relay fee verification

For a Relay request to qualify:
1. The server receives the request ID.
2. The server queries Relay using a server-side API key.
3. The returned record must match the requested ID and have an explicit successful status.
4. Relay's user identity must match a wallet associated with the authenticated Kivo user.
5. The request time must be valid and after the referral was set.
6. The server uses only `data.appFees.actual` entries paid to Kivo's configured fee recipient. An absent or empty actual-fee list can be retried while Relay finishes indexing. A populated list without a Kivo fee is not a reason to estimate one.
7. The server validates associated transaction identifiers, excludes Blue Star payment transactions, and checks previous rewards/source claims.
8. A reward is inserted only when all required checks pass.

Relay API behavior, fee-recipient representation, supported networks, and fee-claim procedures must be verified against current official docs and test evidence before production automation. An aggregate dashboard balance is not per-user reward evidence.

## 5. Duplicate prevention and idempotency

A trade may be reported by both the Relay request path and direct EVM/Solana verification. Both paths must claim stable source identifiers in the same database batch as the reward insertion. Identifiers include Relay request IDs and normalized transaction hashes.

Required behavior:
- Replaying a request ID or transaction hash cannot create another reward.
- Concurrent Relay and chain reports cannot both reward the same trade.
- Historical rewards predating the source ledger must be checked for duplicates.
- Failed inserts must not leave orphan source claims.
- Retries must not increase reward value or reset maturity.

## 6. Weekly settlement target

Weekly settlement is future work, not currently an automatic payout service.

### A. Reconcile
Collect supported Relay claim/fee evidence and independently verified on-chain receipts. Record immutable source IDs and claim transaction identifiers. Reconcile verified amounts with treasury and reward-ledger records. Never assume an undocumented Relay claim endpoint exists.

### B. Calculate liabilities
Select only matured, unpaid, valid rewards not reserved by an active settlement. Separate immature, matured/unpaid, deferred, and paid totals. Use integer micro-USD or another explicitly fixed-precision representation for new settlement calculations.

### C. Calculate spendable budget
Use the lower of the verified spendable treasury balance and configured weekly cap, minus the operational reserve and already committed/pending payouts. Accrued but unclaimed fees are not spendable funds. Never treat an estimated dashboard total as a wallet balance.

### D. Create a deterministic batch
Use a stable weekly period key and idempotent batch creation. Snapshot eligible reward IDs, recipient, network, token/mint, amounts, reserve, treasury watermark, and reconciliation details. A reward can belong to at most one active batch. Missing recipient details or unsupported networks must be deferred, not redirected.

### E. Execute only after approval
Initial mode is dry-run or manually approved. Automatic execution requires explicit operator enablement, a dedicated treasury, a protected server-side signer or approved KMS, spending limits, monitoring, and an emergency stop. Never put private keys in Web/Mobile code or database records.

### F. Verify and recover
Independently verify network, token/mint, recipient, exact amount, and successful transaction receipt/signature before marking rewards paid. A timeout means the outcome is unknown, not failed. Reconcile before retrying; never blindly resend.

### G. Report and audit
Keep tamper-evident records for source fees, claims, batch membership, payout attempts, receipts, errors, deferrals, and reconciliation variances. Admin summaries separate eligible, reserved, submitted, verified, failed/unknown, deferred, and remaining liabilities.

## 7. Data model direction

The referral ledger remains authoritative. Settlement foundation tables cover:
- `relay_fee_claims`: Relay claim/source identity and independently verified claim receipt.
- `referral_settlement_batches`: weekly period key, state, totals, reserve, reconciliation snapshot, and lifecycle timestamps.
- `referral_settlement_items`: one reward per item, with recipient/network/token, amount, status, and payout receipt.
- `referral_payout_attempts`: idempotency key, attempt number, network, transaction/signature, state, and last error.

Use unique constraints for source and transaction identifiers, explicit state transitions, and concurrency tests. Never store signing secrets in these tables. Do not mark rewards paid just because a batch was created or a transaction submitted.

## 8. Security and release gates

Before real-money automation:
- Verify Relay actual-fee and fee-claim API semantics, credentials, supported networks, and claim receipts using official docs and a controlled test.
- Confirm fee-recipient configuration for each network; do not silently fall back to an EVM address for a non-EVM fee record.
- Test server identity binding so EVM and Solana wallets cannot be confused or trusted solely from client input.
- Test referral timing, account deletion, Blue Star exclusions, and fee eligibility.
- Test concurrent source reports, repeated requests, and concurrent settlement workers.
- Test partial settlement, unknown transaction outcome, crash/restart, RPC outage, insufficient balance, malformed receipt, and retry recovery.
- Independently verify payout receipts against expected token/mint, recipient, amount, and network.
- Reconcile dry-run totals against inspected ledger rows and treasury balances.
- Keep admin routes protected by platform-admin authorization and admin unlock, with rate limits and no-store behavior.
- Keep automatic execution disabled by default and impossible to activate through a client request.
- Pass Web tests/typecheck, Mobile verification, Android build, migration validation, and end-to-end tests before merge.

## 9. Current implementation status

### Present on feature branches
- Referral rules and reward ledger.
- Direct EVM/Solana fee verification path.
- Server-side Relay request lookup and actual App Fee parsing.
- Explicit successful-status requirement and retry response when actual-fee data is not ready.
- Shared source-claim ledger intended to prevent Relay/on-chain duplicate rewards.
- Mobile independent Relay request reporting and best-effort retry.
- Settlement design and initial settlement/claim/payout-attempt database tables.

### Not yet implemented or not proven production-ready
- Fully automated Relay App Fee claiming.
- Production treasury reconciliation and reserve calculation.
- Durable scheduled weekly batch creation/execution.
- Protected signer integration and automatic on-chain payouts.
- Independently verified payout receipts wired into reward settlement.
- Full settlement concurrency, recovery, and end-to-end coverage.
- Confirmation that each supported network's Relay fee recipient is represented correctly.
- Final production security audit and operational runbook.

**Do not describe automatic weekly claims or payouts as complete until implemented, verified, and explicitly enabled.**

## 10. Delivery sequence

1. Finish review of Relay actual-fee recording and Web/Mobile behavior.
2. Validate the settlement migration and CI for both PRs.
3. Implement a read-only/dry-run preview showing matured rewards, reserve, spendable balance, and reconciliation gaps.
4. Add deterministic batch creation, reward locks, and concurrency/replay tests.
5. Verify Relay's supported claim flow and reconcile claim receipts. If claiming is dashboard-only, keep that step manual and record its verified receipt.
6. Implement protected payout execution only after treasury/signer approval and verified network-specific transfer behavior.
7. Add receipt verification, unknown-outcome recovery, retries, alerts, and audit reporting.
8. Run controlled dry-run/staging tests; obtain explicit approval before real payouts.
9. Keep Web/Mobile aligned; merge only after checks and the final security audit pass.

## Related links

- Web: https://github.com/rhynox-ui/kivo
- Mobile: https://github.com/rhynox-ui/kivo-mobile-app
- Web referral PR: https://github.com/rhynox-ui/kivo/pull/322
- Mobile referral PR: https://github.com/rhynox-ui/kivo-mobile-app/pull/197
- Relay App Fees docs: https://docs.relay.link/features/app-fees
- Relay Requests v3 docs: https://docs.relay.link/references/api/get-requests
