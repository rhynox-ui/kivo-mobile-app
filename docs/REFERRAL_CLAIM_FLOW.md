# Kivo Referral Claims — Relay Fee Collection and User Withdrawals

**Status:** implementation plan; no automated fee claims or user withdrawals are enabled.

## Decision

Use a two-stage model:
1. Kivo collects its Relay App Fee balance to a controlled Kivo reserve wallet on a weekly cadence.
2. Referral rewards accrue in Kivo's server-side ledger. After the seven-day maturity period, a referrer initiates a claim and authorizes the payout using their own wallet. Kivo must not automatically push funds to every referrer.

Relay fee collection and referral reward withdrawal are distinct flows. Relay App Fees are Kivo revenue; the Kivo ledger separately records the amount owed to each referrer.

## What Relay's official docs establish

- App Fees accrue off-chain in a USDC-denominated balance; they are not paid out in real time.
- App Fee recipients must be EVM-compatible addresses, including for non-EVM transactions.
- The per-request API is `GET /requests/v3` (or the documented compatible request endpoint). Inspect the request's actual paid-fee data, not quoted fees.
- `GET /app-fees/{wallet}/balances` reports accumulated balance by currency and includes total, outstanding fast-fill, and available balance figures.
- `POST /app-fees/{wallet}/claim` prepares a claim flow with `chainId`, `currency`, and `recipient` (and optional amount as documented). Its response contains steps.
- Claiming requires authorization from the configured claim address. The documented SDK `claimAppFees` automates the authorization/signature and permit execution flow. Direct API integrations must complete the returned authorization/permit steps.
- Relay documents Base claims as free; claiming on other chains/currencies may incur a fee. Confirm the selected network/currency and exact amount before executing.
- A successful API response that only describes steps is not proof funds reached the reserve. Re-check Relay's balance and independently verify the destination-chain receipt/balance.

Official references:
- https://docs.relay.link/features/app-fees
- https://docs.relay.link/references/api/get-requests
- https://docs.relay.link/references/api/get-app-fee-balances
- https://docs.relay.link/references/api/claim-app-fees

## Proposed weekly Relay collection

1. Query the configured Kivo fee recipient's App Fee balances.
2. Reconcile against known fee events and the previous successful claim watermark; treat balance totals as aggregate treasury data, not per-user reward evidence.
3. Choose an explicitly configured supported chain/currency and reserve-wallet recipient. Prefer a documented low-cost route only after checking the actual claim fee and operational requirements.
4. Create a durable claim intent with a stable idempotency key and exact wallet, network, currency, amount, and recipient.
5. Request the Relay claim steps and authorize them using a protected server-side signer only if Kivo controls the configured fee-recipient key. Never expose that key in Web/Mobile or database records.
6. Persist each step and transaction identifier before advancing. If a response is lost or status is ambiguous, reconcile Relay and chain state before retrying.
7. Independently verify the destination transfer and reconcile the post-claim Relay balance. Only then record the amount as collected into the Kivo reserve.
8. If the claim address is not controlled by a protected Kivo signer, keep the Relay claim manual (Relay App or multisig) and record its verified receipt. Do not try to bypass authorization.

## User-initiated referral claim

- Keep current economics: 50 bps normal trading fee, 45 bps for referred traders, and 25% of actual eligible Kivo trading fees for the referrer.
- Rewards mature seven days after the qualifying trade.
- The server-side ledger is the source of truth. Show pending, available, claim-in-progress, claimed/paid, and unresolved states separately.
- On Claim, atomically reserve only that user's mature, unpaid rewards and create an idempotent claim intent. Do not trust a client-supplied amount or recipient.
- Resolve the user's previously linked/verified payout wallet and network server-side. Show exact network, token, amount, recipient, and any network fee before the user approves.
- Use wallet approval/signing for the user withdrawal; never ask the user for their private key. The exact payout rail (direct USDC transfer versus a supported Relay route) must be selected and verified per network before implementation.
- Mark rewards paid only after independently verifying chain, token/mint, recipient, exact amount, and successful receipt/signature.
- Unknown outcome is not failure. Keep the claim reserved and reconcile before retrying; never blindly resubmit.
- Release a reservation only when evidence proves no transfer occurred. Every state transition and receipt must be auditable.

## Security and rollout gates

- Automatic Relay fee claiming is disabled until the fee-recipient signing authority is confirmed and protected, limits/alerts are configured, and a controlled claim is tested.
- User claims are disabled for real funds until supported networks, payout signing, recipient verification, idempotency, concurrency, timeout recovery, and receipt verification pass tests.
- Keep automatic execution disabled by default. Use dry-run previews first; never apply production migrations or move real funds without the approved release process.
- Web is the authoritative reward/settlement backend; Mobile must call the same APIs and must not maintain a separate ledger.
