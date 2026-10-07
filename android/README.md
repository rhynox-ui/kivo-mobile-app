# Kivo Android

Based on the React Native 0.87 stable Android template.

Play baseline:
- compileSdk 37
- targetSdk 36 (Android 16)
- minSdk 24
- New Architecture enabled
- Hermes enabled
- applicationId: com.kivo.chat
- versionName: 0.1.0
- versionCode: 1

Google Play requires new apps and updates submitted from August 31, 2026 to target Android 16 (API 36) or higher.

Release signing is intentionally not finalized yet. Before production upload, configure a dedicated upload keystore and Play App Signing. Never commit the keystore or passwords.

Release artifact: Android App Bundle (AAB).
