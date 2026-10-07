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
