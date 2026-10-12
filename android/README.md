# Kivo Android

React Native 0.87 Android application for Kivo Mobile.

## Android baseline

- compileSdk 37
- buildToolsVersion 37.0.0
- targetSdk 36 (Android 16) — required for new apps and updates submitted to Google Play from August 31, 2026.
- minSdk 24
- New Architecture enabled
- arm64-v8a included for Google Play 64-bit support
- React Native 0.87 provides Android 16 and 16 KB page-size support; third-party native libraries must remain compatible.
- Hermes enabled
- applicationId: `com.kivo.chat`

Google Play requires new apps and updates submitted from August 31, 2026 to target Android 16 (API 36) or higher.

## Release signing

Kivo release signing is configured through protected GitHub Actions secrets. The release keystore is decoded only during CI and is removed after the build.

Required GitHub Actions secrets:

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`

The keystore is an Android/Google Play **upload key**. It is not the private app-signing key held by Google Play after Play App Signing is configured.

Never commit the keystore, signing password or private key to the repository.

## Release artifacts

The release workflow produces:

- **Signed APK** — direct Android testing/install.
- **Signed AAB** — Google Play upload.

The workflow allows the release version name to be chosen manually and derives the Android version code from the GitHub Actions run number so version codes increase automatically.

The Play track selector supports:

- internal
- alpha
- beta
- production

Automatic Play publishing only occurs when the protected `PLAY_SERVICE_ACCOUNT_JSON` secret is configured. Building a release does not by itself publish to Google Play.

## First Play release

For a new Play application, configure Google Play App Signing in Play Console and upload the signed AAB. Complete internal testing and Play Console requirements before promoting the release to production.

## Google Play 2026 compliance

Kivo's Android release baseline is aligned with the current Google Play requirements checked on October 8, 2026:

- New apps and app updates target Android 16 (API 36) or higher.
- The release uses an Android App Bundle (AAB) for Google Play.
- The app includes a 64-bit ARM ABI (arm64-v8a).
- React Native 0.87 is used; its Android 16 toolchain is compatible with the current target.
- 16 KB page-size compatibility is required for native code. Kivo has no custom C/C++ native module; React Native 0.87 provides 16 KB support, and third-party native dependencies must remain compatible.
- Release signing uses the protected Play upload key; Google Play App Signing remains the final app-signing layer.
- Version codes increase automatically from GitHub Actions run numbers.

### Play Console items outside the APK/AAB

These must be completed and kept accurate in Play Console before production submission: developer identity verification, package-name registration, privacy policy, Data safety, target audience, content rating, app access/demo credentials where needed for review, store listing metadata, and account-deletion functionality where the app provides account creation.
