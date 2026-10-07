# Kivo Trading Engine

One trading engine, used by both Kivo clients:

- `web/` imports it as `@kivo/trading/*` (Vite alias, `web/vite.config.js`)
- `mobile/` imports it as `@kivo/trading/*` (TS paths + Metro `extraNodeModules`, `mobile/metro.config.js`)

## `core/` — ported Mango Pro engine (source of truth)

Ported from https://github.com/rhynox-ui/mango-pro `src/core/`. Do not fork
quote, routing, fee, balance or firewall logic in either client.

Wired into Kivo today:

| Module | Used for |
| --- | --- |
| `relayQuote.ts` | Relay quote construction, app fee, intent tagging |
| `txIntentFirewall.ts` | Pre-sign checks: amount, tokens, chains, recipient, approvals |
| `chainData.ts`, `chainRegistry.ts` | Chain ids, verified token addresses, RPC fallbacks |
| `tokenSearch.ts`, `dexScreener.ts` | Token search (DexScreener) |
| `discoveryFeed.ts`, `geckoTerminalNetworks.ts` | Trending tokens (DexScreener boosts + GeckoTerminal) |
| `fees.ts`, `relayGaslessEvm.ts` | Fee rules; gasless capability check (sponsorship disabled for Kivo) |

Present but **not wired** (they need modules or infrastructure Kivo does not
have yet — Solana signer, Kivo-owned sponsor/proxy backend, fallback-DEX
providers): `executeRelayQuote.ts`, `fallbackDex.ts`, `fallbackTxFirewall.ts`,
`usdcBalances.ts`, `solanaSpendGuard.ts`, `solanaTxIntent.ts`,
`walletPrices.ts`, `tradeErrors.ts`. They are excluded from typechecks because
nothing imports them. `fallbackDex.ts` and `relayGaslessEvm.ts` still point at
mangoprotocol.site proxy URLs — replace with Kivo-owned endpoints before
wiring them.

## `kivo/` — Kivo adapter over the engine

| Module | Purpose |
| --- | --- |
| `tokens.ts` | `KivoToken` model, trade-support gate (Solana/NEAR view-only, watch-only wallets cannot sign), formatting |
| `balances.ts` | Real on-chain USDC (per chain) and token balances via the engine's RPC transports |
| `quote.ts` | Trade ticket → `getRelayQuote()` → display model (receive, minimum received, impact, fees, ETA, route, expiry) |
| `execute.ts` | Firewall-guarded executor behind a `KivoEvmSigner` interface + Relay status polling |
| `history.ts` | Local history of trades that were actually broadcast |
| `market.ts` | Token detail stats (DexScreener) and OHLCV candles (GeckoTerminal) |

### Execution boundary

`executeKivoQuote()` follows the engine's own executor step for step
(intent present → quote fresh → transaction steps only →
`assertQuoteSafeToSign()` over every pending item before the first signature →
send in order, confirm each receipt → poll Relay). Only the signer differs:

- Web: the connected browser wallet (EIP-1193). Kivo never sees keys.
- Mobile: the device keychain wallet. The phrase is read at confirm time,
  turned into a viem account inside `walletStore.localEvmSigner()`, and never
  returned or logged.

Execution pays normal network gas from the user's wallet. Relay gas
sponsorship stays off until Kivo runs its own sponsor infrastructure.
