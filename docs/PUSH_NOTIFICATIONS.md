# Native push notification setup

Kivo's followed-trade push flow uses the Kivo social API for token registration and Firebase Cloud Messaging for Android delivery.

## Android Firebase configuration
Register Android package `com.kivotrade.app` in the Firebase project used by the Kivo backend. Add these environment values to the Android release build job so Gradle can configure the app:
- `KIVO_FCM_PROJECT_ID`
- `KIVO_FCM_APP_ID`
- `KIVO_FCM_API_KEY`
- `KIVO_FCM_SENDER_ID`

The app fails safe without these values; it does not register a push token. Keep the Firebase service-account private key only in Cloudflare Pages secrets as `FCM_PRIVATE_KEY` (with `FCM_PROJECT_ID` and `FCM_CLIENT_EMAIL`).

The app requests notification permission, obtains the FCM token through `KivoPushModule`, and registers it after wallet session restore/sign-in. Successful mobile swaps call the authenticated trade notification endpoint. Tapping a push opens Activity / trade history.

For iOS delivery, register the iOS bundle ID in Firebase, configure APNs credentials, and add Firebase Messaging to an iOS native target. This repository currently contains the Android native target only.
