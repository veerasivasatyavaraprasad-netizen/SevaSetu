# SevaSetu mobile app (Android & iOS)

A native app for customers and workers, built with Expo SDK 57, React Native 0.86 and Expo Router. It talks to the same API as the web app, so every security control is enforced server-side exactly as on the web.

## What the native app adds over the web app

- **Real fake-GPS detection.** Check-in and completion send the OS mock-location flag (`LocationObject.mocked` on Android). The API suspends the worker immediately if it's set (plan §9.6). Browsers can't detect this.
- **Push notifications.** The app registers its FCM device token with `/api/devices`, and the API sends job alerts, payment and payout updates through FCM HTTP v1.
- **Native Razorpay checkout** through `react-native-razorpay` (New Architecture TurboModule). The API still verifies the signature *and* re-fetches the payment from Razorpay.
- **Camera KYC:** ID and selfie photos straight from the camera.
- **Secure session storage.** The refresh token lives in the OS keystore (`expo-secure-store`), rotates on every use, and is revoked on logout. The access token stays in memory only.

## Screens

**Customer**
- OTP login with privacy consent
- Home: search, categories, sponsored placements
- Service detail with reviews
- Booking: address with a GPS pin and serviceability check, day and slot, fixed-price quote, urgent premium, 30-day guarantee, cancellation policy, pay
- My bookings; booking detail with the completion code, "Worker asked for cash", confirm and rate, disputes, guarantee claim, cancel, chat and masked calls
- Maintenance plans
- Account: addresses, notifications, DPDP data export and account deletion

**Worker**
- Onboarding: profile and ID, camera documents, penny-drop payout verification, policy sign-off, submit, then under review
- Jobs dashboard with featured-priority hints; accept or skip
- Job detail: navigation, GPS check-in, OTP completion, chat and call, withdraw
- Earnings and weekly payouts
- Featured plans
- Policy and account

## Run it

Razorpay and push notifications need native code, so use a **development build**, not Expo Go:

```bash
cd mobile
npm install                      # .npmrc sets legacy-peer-deps for react-native-razorpay
EXPO_PUBLIC_API_URL=http://10.0.2.2:4000 npx expo run:android   # Android emulator → API on your machine
EXPO_PUBLIC_API_URL=http://localhost:4000 npx expo run:ios      # iOS simulator (macOS)
```

Against a development API (mock payment provider), the Pay button shows a development confirmation instead of Razorpay.

## Release builds (EAS)

```bash
npm install -g eas-cli && eas login
eas build --platform android --profile production   # Play Store bundle
eas build --platform ios --profile production       # App Store build
```

Before building:
- Set `EXPO_PUBLIC_API_URL` in `eas.json` to your live API URL (https).
- **Android push:** add your Firebase `google-services.json` and set `"android.googleServicesFile"` in `app.json`. The API needs `PUSH_PROVIDER=fcm` and `FCM_SERVICE_ACCOUNT_JSON`.
- **iOS push:** device tokens on iOS are APNs tokens. Upload your APNs key to Firebase and add `GoogleService-Info.plist` (with `"ios.googleServiceFile"`). Until then, iOS users get in-app notifications, SMS OTPs and emails but no push.
- Replace the placeholder icons in `assets/`.

## Checks

`npm run export:check` bundles the app for Android and iOS. CI runs it on every push, so a broken import or syntax error fails the build.
