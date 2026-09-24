// The API origin, e.g. https://sevasetu-app.onrender.com. Set at build time:
//   EXPO_PUBLIC_API_URL=https://… npx expo run:android
// Must be https in release builds (Android blocks cleartext by default).
export const API_URL = (process.env.EXPO_PUBLIC_API_URL || 'http://10.0.2.2:4000').replace(/\/$/, '');
