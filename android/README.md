# Kivo Android

React Native 0.87 Android application for Kivo Mobile.

## Android baseline

- compileSdk 37
- targetSdk 36 (Android 16)
- minSdk 24
- New Architecture enabled
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
