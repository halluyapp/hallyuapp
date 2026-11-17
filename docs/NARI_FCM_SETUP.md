# Firebase Cloud Messaging setup — existing Hallyu Android app

Use the **same Firebase project** for the Android configuration and server sender.
No legacy FCM server key is needed: the dispatcher uses FCM HTTP v1.

## Obtain these items

1. Firebase Console → Project settings → General: select/register the Android app
   with package **`com.hallyu.app`**. Download **`google-services.json`** for that
   exact app/project. This is Android build configuration, not the service-account
   private key. Use the existing secure build configuration (`app.config.js`
   reads `./google-services.json`); rebuild/install Android after configuring it.
2. Firebase Console → Project settings → Service accounts → Firebase Admin SDK:
   generate/download a **service-account JSON** for the same project. It contains
   `project_id`, `client_email`, and `private_key`. This is **private server material**.
   Configure its full JSON securely in existing Supabase project Edge Function
   secrets as **`FCM_SERVICE_ACCOUNT_JSON`**, or the existing protected build-vault
   key `fcm_service_account_json`. Do not attach the private JSON to chat, place it
   in an `EXPO_PUBLIC_*` variable, embed it in an APK, or commit it to Git.
3. Ensure Firebase Cloud Messaging API (HTTP v1) is enabled in that Google Cloud
   project and the service account can send FCM messages (Firebase Cloud Messaging
   API Admin / appropriate least-privilege equivalent).
4. Install the configured official Hallyu Android build on a real phone. Sign in,
   enable notification permission under Settings → Notifications and retry device
   registration until the app reports an active FCM registration.

## Verification

- Confirm dispatcher `fcm_configured:true` and `fcm_oauth_verified:true` using the
  authorized server-only `push-dispatch` `verify_fcm:true` probe. Do not expose its
  service credential in a client request or chat.
- Confirm the consenting test user's real `fcm:` device token is saved and active;
  never invent an FCM token or print the complete token.
- Send one targeted test to **that user only**, then verify notification history,
  delivery record/provider result, and actual phone receipt with the app closed.
- Recheck opt-outs, quiet hours and token ownership. Successful OAuth or HTTP200
  alone is not delivery proof.

Web Push is separate and already has VAPID configuration; it does not require a
Firebase private key. iPhone Safari Web Push requires Home Screen installation.
No APNs configuration is requested for this Android FCM setup.
