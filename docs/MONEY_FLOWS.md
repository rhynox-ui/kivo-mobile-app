# Money flows (mobile)

How money moves in the Kivo mobile app: one home balance, automatic moves,
and who pays which fee. Code references are relative to this repo.

## Home balance: USDC on Solana

Kivo works like an exchange account: the user sees one dollar balance and
never has to think about networks.

- The home balance is **USDC on Solana** (`trading/kivo/home.ts`, `HOME_CHAIN`).
- **Buys** spend Solana USDC. Solana tokens are one direct swap.
- **Sells** always pay out to Solana USDC (`trading/kivo/quote.ts`, `receiveAsset`).
- **Convert** (`src/components/ConvertCashSheet.tsx`) stays available for
  manual swaps between coins and networks.

## Deposits

`DepositSheet` in `src/screens/WalletSummaryScreen.tsx`.

- Every supported cash network can receive. **Solana is listed first and
  marked Recommended**: it is the home balance, so the money is ready at once.
- Other networks (Ethereum, Base, BNB Chain, Arbitrum, …) show their address
  and a note that Kivo moves the deposit to Solana USDC automatically.
- **NEAR is not offered for deposits**: the automatic move home does not cover
  NEAR, so money there would sit unused. NEAR still appears under Withdraw.

## Automatic move home

`trading/kivo/sweep.ts` and `src/wallet/autoSweep.ts`.

- Money that lands on another network, or in another coin, is moved to Solana
  USDC with one Relay route per asset. The user does nothing.
- It runs on the device only while the wallet is unlocked: in the background
  at most every 5 minutes, and on demand when a buy needs more home cash than
  the user has (the buy review reopens once the move is done).
- Only assets worth **$1 or more** are moved (`MIN_SWEEP_USD`).
- Never moved:
  - **SOL on Solana**. It is the home network's gas coin, and selling it only
    costs a route fee.
  - **Anything in Kivo's own fee wallets** (`isFeeExemptWallet`). Their SOL and
    ETH are the float Kivo uses to sponsor users' fees.
  - NEAR.

## Withdrawals

`withdrawFromHome` / `quoteHomeWithdrawal` in `trading/kivo/cash.ts`.

- Withdrawals come from Solana USDC and can go to **any supported network**
  (USDG on Robinhood Chain, USDC elsewhere) in one Relay route.
- Kivo charges **no app fee** on withdrawals. Relay's own cost (about $0.02
  plus the destination network's gas) comes out of the amount, and the exact
  amount received is shown before confirming.
- Sending Solana USDC to a new Solana address: Kivo pays the recipient's
  one-time token-account rent and recovers it from the sender's USDC in the
  same transaction.

## Fees and sponsorship

Users never need SOL or ETH for gas.

- **Kivo app fee** (`trading/core/fees.ts`, `kivoFeeUsd` — the one place it is
  computed; `kivoFeeBps` derives the bps sent to Relay/1Click/aggregators).
  "pct" is 0.5%, or 0.45% for referred users.
  - **Solana** (Kivo pays the network fee): `max(pct × amount, min(2% × amount, $0.95))`.
    $10 → $0.20, $25 → $0.50, $50–$190 → $0.95, $250 → $1.25, $500 → $2.50, $1,000 → $5.00.
  - **Every other chain** (Base, BNB, Ethereum, Arbitrum, Robinhood, NEAR…): `pct × amount`.
  - **Blue chips** (SOL/wSOL, ETH/WETH, WBTC/cbBTC/BTCB, BNB/WBNB — explicit
    per-chain list `BLUE_CHIP_TOKENS`, `isBlueChip`): 0.05% (0.045% referred), no minimum.
  - Classified by the token bought or sold (never the USDC side), on its own
    chain; capped at $50 per trade. Waived on withdrawals and for Kivo's own wallets.
- **EVM gas:** sponsored through Relay (gasless EIP-7702 + Calibur batch). The
  Kivo server keeps the sponsored cost at or below 80% of the app fee and
  raises that trade's fee if needed, never above 5%.
- **Solana fees:** Kivo's fee payer (`2ApuoL…amki`) pays the network fee,
  priority fee and new token-account rent up front. Kivo **absorbs the network
  and priority fee** (no margin). Only the one-time token-account rent (the
  user's refundable deposit) and any SOL top-up are recovered at cost (+1%
  USDC→SOL conversion buffer) in the same transaction, in USDC (falling back to
  SOL) (`trading/core/executeRelayQuote.ts`, `estimateRecoverableRentLamports`).
- **Kivo's fee wallets can't sponsor themselves.** Trading from the fee wallet
  without SOL shows: "This is Kivo's fee wallet, so Kivo can't cover its
  fees…". Test with a separate wallet; keep the fee wallets as treasury only.

Server-side limits on sponsorship (what Kivo will and won't pay for) are
documented in the kivo repo, `docs/FEES.md`.

## Discover: trending tokens

`trading/core/discoveryFeed.ts`.

- Per-chain trending comes from GeckoTerminal. The phone asks GeckoTerminal
  directly first; if it is rate limited or blocked, Kivo's caching proxy
  (`/api/market/geckoterminal`) answers instead.
- If both are empty, the chain falls back to DexScreener's boosted tokens on
  that chain, so a network never shows an empty list just because one source
  is busy. Charts use the same direct-then-proxy path.

## Confirm and sign

The confirm button gives instant feedback: a light vibration (Haptics
setting), a ripple, and a pressed-in look that stays while the trade runs.
It accepts one tap, so a double tap can't start two trades.
