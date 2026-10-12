# Kivo Trading Engine Port

Kivo uses the existing the existing trading implementation trading implementation as the source of truth for trading execution.

## Ported

The the existing trading implementation core execution layer is now present under:

`trading/core/` (shared by web and mobile — see `trading/README.md`)

Ported modules include:

- chain data and registry
- Relay quote construction
- Relay execution
- transaction-intent firewall
- Solana transaction-intent validation
- EVM fallback DEX execution
- fallback transaction firewall
- fee calculation
- Relay gasless capability
- Solana spend guard
- trade error normalization
- USDC balance aggregation

Source: internal source lineage

## Integration rule

Kivo must not create a second quote router or duplicate the existing trading implementation execution logic.

Kivo's social UI, identity and wallet/session layers adapt to the existing engine. The execution implementation remains the source of truth.

## UI direction

Kivo trading follows the supplied reference experience: portfolio/balance context, market search, chart/market data, Buy/Sell controls, amount presets, payment/receive assets, fee/ETA information and execution states.

Those controls are wired to the ported engine rather than recreated as a separate trading implementation. Web (`web/src/pages/trade.ts`) and mobile (`mobile/src/screens/TradeScreen.tsx`) share the same layout, top to bottom:

- **Cash** total (USDC across supported chains, read on-chain) with a **Paying on / Trading on** chain pill (buy side opens the USDC chain picker), **Search** and a **settings** gear (max slippage: Auto, 0.5%, 1%, 2%, 5%).
- Token row, social links from DexScreener, GoPlus **Holders ▾** sheet and honeypot/risk flags (`trading/core/goplusTokenSecurity.ts`).
- DexScreener chart embed. On mobile it runs in `react-native-webview` and may only navigate within `dexscreener.com` (`mobile/src/components/TokenChartPanel.tsx`).
- Big **Buy** / **Sell** buttons. Tapping the other side switches the ticket; tapping the active side when a fresh quote is ready opens the review sheet. The review sheet runs the transaction firewall before the wallet prompts.
- Hint line, **25% / 50% / 75% / MAX / Custom** presets, **You pay** / **You receive** cards, and a **Fee · ETA** row with expandable route details (minimum received, price impact, fees, slippage, route, approvals, quote expiry).

When something cannot be done (no wallet, unsupported chain, no route, expired quote), the hint line says so. The UI never shows a placeholder quote or a success state.

iOS builds need `cd mobile/ios && pod install` after pulling (new native dependencies: `react-native-webview`, `react-native-image-picker`, `@react-native-async-storage/async-storage`). Android autolinks them.

## Branding

The port is an internal implementation dependency. User-facing UI remains Kivo-branded.

## Release gate

The port is source-complete for the selected core modules. It is not claimed production-ready until Kivo's signer/session adapters, required native dependencies, wallet security boundary and end-to-end trade verification are connected.

## Execution by platform

Kivo follows Mango's own split between its website and the Mango Pro app.

| | Web (kivotrade.site) | Mobile app |
|---|---|---|
| Wallet | User's browser wallet (EIP-6963), connected per session | Kivo wallet on the device (create or import), keys in secure storage |
| Signing | Wallet sends each transaction (`trading/kivo/execute.ts`) | Device signs one EIP-7702 delegation + one Calibur batch (`trading/kivo/gasless.ts`) |
| Gas | Paid by the user | Paid by Kivo through Relay sponsorship |
| Cash | Any wallet balance; buys pay in USDC | USDC only; gasless withdraw (`trading/kivo/cash.ts`) |

There is no fallback from gasless to a gas-paying transaction on mobile. If sponsorship is unavailable, the app says so and does not trade.

### Kivo backend (`web/server/relay.ts`, routes under `/api/relay/*`)

- `GET config`: whether gasless is on (true when `RELAY_API_KEY` is set).
- `POST quote`: proxies Relay `/quote`. Forces the fee recipient (`KIVO_FEE_WALLET`) and caps the rate at 50 bps. Requests sponsorship only when a key is set. Caps `maxSubsidizationAmount` at 5 USDC. Records gasless orders in D1 `relay_orders`.
- `POST execute`: proxies Relay `/execute` with `subsidizeFees`. It sponsors only two shapes: (1) a Calibur batch that targets the signer's own address, carries no native value, delegates only to Calibur, and uses a requestId Kivo quoted for that wallet (single use, 10-minute TTL, 200 per day); (2) a single USDC transfer (10 per day).
- `GET status`: proxies Relay status for the browser.

To enable gasless: set the Cloudflare secret `RELAY_API_KEY` (a Relay key with a funded app balance) and the variable `KIVO_FEE_WALLET` on the kivo-web project.
