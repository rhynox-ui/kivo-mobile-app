# Kivo Mobile App

Standalone React Native Android application for Kivo.

This repository contains the **Kivo Mobile** product. The Kivo Web product remains in the main Kivo repository.

## Product boundary

- **Mobile:** Kivo wallet, unified USDC balance, mobile trading, social/community, profile, notifications and mobile-native wallet security.
- **Web:** separate external-wallet product in the main Kivo repository.
- Never move Web connected-wallet funding assumptions into Mobile.
- Never move Mobile local-wallet/seed handling into Web.

The `shared/` and `trading/` directories are the mobile app's required shared contracts/trading engine snapshot. The Web repository keeps its own copy because Web and Mobile are separate deployable products.

## Development

```bash
npm install
npm run typecheck
```

Android project:

```bash
cd android
./gradlew assembleDebug
```

## Security

The mobile wallet is non-custodial. Recovery material stays in secure device storage and is never sent to the Kivo API.

## Layout

| Path | What it is |
| --- | --- |
| `App.tsx`, `index.js`, `src/` | The React Native app (screens, wallet store, session, components) |
| `android/` | Android project (`com.kivo.chat`, React Native 0.87, Hermes, New Architecture) |
| `trading/` | Trading engine snapshot: `core/` (quotes, intent firewall, chains, gasless EIP-7702 execution) and `kivo/` (Kivo adapter: balances, quotes, gasless executor, USDC withdraw, portfolio) |
| `shared/` | Social and profile contracts, Kivo API client, device-first chat store |
| `docs/` | Web/mobile contract, trading engine notes, mobile UI rules |

`@kivo/trading/*` and `@kivo/shared/*` resolve to these folders (`tsconfig.json` paths, `metro.config.js` `extraNodeModules`).

## How mobile trading works

- The wallet lives on the phone (create or import a 12/24-word phrase; stored with `react-native-keychain`). There is no "connect wallet".
- Cash is USDC. Trades and withdrawals are gasless: the phone signs one EIP-7702 delegation (first trade only) plus one Calibur batch, and Relay submits it with gas sponsored through the Kivo backend (`https://kivo-web.pages.dev/api/relay/*`).
- Every route passes the intent firewall (`trading/core/txIntentFirewall.ts`) before anything is signed. If sponsorship is unavailable the app says so and does not fall back to a gas-paying transaction.

## Backend

The app talks to the Kivo API hosted with Kivo Web (`KIVO_API_BASE_URL` in `src/state/session.ts`): social sign-in, profiles, chats, communities, media, and the Relay proxy. Gas sponsorship turns on when `RELAY_API_KEY` is set on the kivo-web Cloudflare project.
