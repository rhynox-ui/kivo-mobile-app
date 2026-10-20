# Kivo Referral Settlement — Relay Fee Collection and Weekly Payouts

**Status:** staged implementation. Actual Relay fee claims and automatic on-chain referral payouts are not enabled.

## Intended operating model

Kivo's target is a **weekly automated settlement**, not a referrer-initiated withdrawal flow:

1. Reconcile Relay's accumulated App Fee balances against verified per-request fee records and the configured Kivo fee recipient.
2. Claim eligible Relay App Fees to a controlled Kivo reserve wallet, using Relay's documented claim authorization flow.
3. Reconcile the resulting on-chain receipt and reserve balance.
4. Snapshot matured referral liabilities in an idempotent weekly batch. Referral rewards are 25% of eligible actual Kivo fees, after the seven-day maturity delay.
5. Distribute approved, matured rewards from the reserve to each referrer's verified destination wallet, then verify every receipt and update the ledger.
6. Report success only after chain verification. On an ambiguous outcome, reconcile before any retry.

Until the treasury signer, reserve funding, token/network mapping, per-recipient limits, operational monitoring, and recovery paths are audited, the system must remain in dry-run/manual-approval mode. The settlement planner is not authorization to transfer funds.

## Separate ledgers

Relay App Fees are Kivo revenue and accrue to the configured App Fee recipient's Relay balance. Referral rewards are a separate Kivo liability. Aggregate Relay balances do not prove an individual referral reward; per-request actual fee evidence and the shared referral source ledger remain authoritative.

## Relay API behavior to use

- Per-request actual fee evidence: `GET /requests/v3`.
- Accrued App Fee balance: `GET /app-fees/{wallet}/balances`.
- Claim preparation: `POST /app-fees/{wallet}/claim`.
- Relay documents the `claimAppFees` SDK flow for claim authorization/signature/permit execution.
- Verify the destination chain receipt and resulting balance; a returned list of claim steps is not proof that a claim succeeded.

Official references:
- https://docs.relay.link/features/app-fees
- https://docs.relay.link/references/api/get-requests
- https://docs.relay.link/references/api/get-app-fee-balances
- https://docs.relay.link/references/api/claim-app-fees

## Required safety controls before enabling live transfers

- Server-side idempotency for every Relay request, settlement period, reward row, payout item, and transaction attempt.
- Unique reservation of each reward in one batch; never settle the same reward twice.
- Verified treasury signer and explicit allow-listed networks/tokens/recipient addresses.
- Minimum reserve buffer, per-run and per-recipient caps, and a stop switch.
- Serialize signing and nonce use per network; persist transaction intent before broadcast.
- A timeout or unknown RPC result is **ambiguous**, not failed. Reconcile transaction hash, receipt, nonce, and destination balance before retrying or releasing the reservation.
- Mark a reward paid only after a verified on-chain receipt matches the intended network, token, amount, and recipient.
- Admin audit trail and alerts for failed, delayed, or ambiguous attempts.

## Current implementation boundaries

- Referral attribution and eligible fee recording are handled by the shared Web backend.
- Weekly settlement planning reserves matured rewards without broadcasting transactions.
- The authenticated referral claim-balance endpoint is read-only and separates pending, available, reserved, and paid totals.
- No user withdrawal endpoint, automatic Relay claim, treasury signing, or live payout is enabled.
- Keep Web and Mobile consistent with the backend ledger; never trust client-calculated reward totals.
