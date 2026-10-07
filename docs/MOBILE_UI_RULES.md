# Kivo Mobile

Kivo's mobile client is a fully Kivo-branded social wallet and trading application.

## Branding rule

All user-facing mobile UI must use **Kivo** branding only.

- Splash screen: Kivo logo and Kivo graphics only.
- Onboarding: Kivo name, Kivo logo and Kivo visual language only.
- Wallet screens: Kivo branding only.
- Navigation, loading states, empty states and error screens: Kivo branding only.
- Do not display the Mango name, Mango logo, Mango colors, or Mango product references anywhere in the user-facing app.

The trading engine may be ported internally behind the Kivo trading adapter. Its branding must never leak into the Kivo UI.

## Target UI

- Chats
- Groups
- Discover
- Wallet
- Profile
- Trade

Trading screens should call the shared Kivo trading adapter, which delegates to the ported trading core.
