# Web / Mobile Contract

Kivo web (repo `rhynox-ui/kivo`, Cloudflare Pages, kivotrade.site) and Kivo
mobile (this repo, `rhynox-ui/kivo-mobile-app`, Android `com.kivo.chat`) are
two separate deployable products that share contracts and the trading engine.
Each repo keeps its own copy of `trading/` and `shared/`; when one changes,
port the change to the other deliberately.

| Shared module | What both clients get |
| --- | --- |
| `trading/core` | Mango Pro engine: Relay quotes, intent firewall, chain data, token search, trending |
| `trading/kivo` | Token model, trade-support gate, balances, quote view, firewall-guarded executor, trade history, market data |
| `shared/social` | Channels/groups, permission rules, persisted store |
| `shared/profile` | Wallet-linked profile model, validation, persistence |

## Identity rules (both clients)

- The live wallet session is the only proof of wallet ownership.
- A profile's `userId` is derived from the session's wallet address
  (`kivo:<address>`). Username, avatar, bio, badges and reputation are display
  data and never prove ownership.
- Web never asks for, stores or handles seed phrases or private keys.
- Mobile local wallets keep the phrase in the device keychain; it is never shown
  in UI after backup and never logged.

## Community rules (both clients, enforced in `shared/social`)

- The creator is the owner and has the highest authority.
- Only the owner promotes or demotes admins.
- Admins manage regular members only; never the owner or other admins.
- Promotion never transfers ownership; the owner cannot be removed or leave.

## Trading rules (both clients, enforced in `trading/kivo`)

- Quotes come only from the engine (`getRelayQuote`). No mock quotes, balances,
  hashes or success states.
- Every pending transaction passes `assertQuoteSafeToSign` before the first
  signature; stale quotes (>2 min) and wallet changes are refused.
- Solana and NEAR tokens are view-only until a matching signer exists;
  watch-only mobile addresses cannot sign.

## Platform-only

Web: browser wallet provider (EIP-1193/6963), Cloudflare Pages, responsive UI, localStorage.
Mobile: React Native UI, keychain, AsyncStorage, Android packaging.

Rules:
- Do not import React Native packages into `trading/` or `shared/`.
- Do not import browser-only globals into the app, `trading/` or `shared/`.
- Do not make Cloudflare builds depend on Android tooling, or Android builds on Cloudflare credentials.


## Private media authorization (9 Oct 2026)

- The Cloudflare Pages API in `rhynox-ui/kivo` is the shared authorization source for web and mobile media URLs. Mobile must not bypass it with direct R2 access or cache private URLs as public assets.
- Private message media is re-authorized against current session and conversation access at fetch time. A removed member or non-participant may receive a denied/expired URL.
- The mobile conversation screen displays a bounded `Photo unavailable` placeholder when a remote image cannot load, instead of leaving a broken image.
- Regression/build verification is still required; a placeholder is graceful failure handling, not a replacement for server-side authorization.


## Message retry and private media safety

- All message sends, edits, deletes, and private media reads must go through the shared Kivo social API in `rhynox-ui/kivo`; mobile UI checks are not authorization.
- The API treats `clientId` only as an idempotency key. A retry is accepted only for the same authenticated sender and same conversation; reusing another message's ID must return HTTP 409 and must not disclose the existing message.
- The API revalidates current access to private message media. Mobile shows a safe `Photo unavailable` placeholder when access has expired or been revoked.
- These API/client changes have been committed, but tests and Android typecheck/bundle verification still need an owner-authorized manual run.


## API abuse controls and CORS

- The shared API applies exact browser-origin CORS allowlisting at its boundary. Native React Native networking is not authorized by CORS; every API route still enforces server-side identity/permissions.
- Auth challenge/verification, profile approval/update, media uploads, provider-backed fallback/Relay quotes, and sponsored Relay execution have bounded IP-scoped limits.
- On HTTP 429, show the server's retry guidance and avoid immediate retry loops. Do not retry transaction submission automatically.
