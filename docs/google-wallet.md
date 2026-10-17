# Continue with Google (wallet backup in the user's Google Drive)

## What it does
- **First time:** the user signs in with Google and sets a Kivo password. Kivo then:
  - creates a normal 12-word wallet on the phone;
  - encrypts the phrase on the phone with that password (PBKDF2-SHA256, 600k iterations, then AES-GCM, the same as the on-device vault);
  - saves it to the user's own Google Drive, in the hidden app-data folder (`drive.appdata` scope).
- **New phone:** Continue with Google, then the same password, and the wallet is restored.
- **Existing wallets:** Settings → Security → Back up to Google Drive.
- Kivo's servers never receive the phrase, the password or the backup. There is no wallet provider and no per-user cost.
- Wallets imported from a private key can't be backed up this way, because they have no phrase.

## Security
- **Google account alone:** gets only ciphertext. The 14+ character password policy plus 600k PBKDF2 iterations make offline guessing expensive.
- **Kivo alone:** has nothing.
- **Forgotten password:** restore with the recovery phrase (Settings → Security → Reveal recovery phrase). Kivo can't reset it.

## One-time setup (Google Cloud console)
1. Create or choose a project, then enable the **Google Drive API**.
2. Configure the **OAuth consent screen**:
   - set the app name (Kivo), support email and logo;
   - add the scope `https://www.googleapis.com/auth/drive.appdata`;
   - publish the app. While it is in "Testing", only listed test users can sign in.
3. Create an **OAuth client ID** of type **Android**:
   - package `com.kivotrade.app`;
   - the **SHA-1** of the keystore that signs the release build (`keytool -list -v -keystore <release.keystore>`);
   - add another Android client for the debug keystore if you test debug builds;
   - if Play App Signing is used, add the SHA-1 from Play Console → App integrity.
4. No `google-services.json` and no code change are needed. Android matches the app by package name and SHA-1.
