# Web auth fix — "You appear to be offline" on web sign-in

## Symptom

On the web build (GitHub Pages, localhost, any custom domain), tapping **Continue with Google**
failed with *"You appear to be offline — try again"* — even on a perfectly working connection.
Native (Android/iOS) was never affected.

## Root cause

Rork's auth server (`api.rork.com`) answers CORS **only for allowlisted origins** (`rork.com`,
`*.rork.app`). Every `/oauth/*` call from any other web origin — the GitHub Pages deploy,
localhost, a custom domain — is blocked by the browser before it leaves the page. A CORS block
and a dead network throw the **same** error (`TypeError: Failed to fetch`), and the auth layer
mapped that error to "offline". The message blamed the member's device when the device was fine —
and nothing could be retried into working, because the request could never succeed from that origin.

## The fix (two halves)

1. **Honest classification** (`lib/api/client.ts`, `lib/auth.tsx`): "offline" is now reported only
   when the device actually is offline (the browser's own `navigator.onLine`, NetInfo on native).
   A transport failure while online reports *"the sign-in service refused the connection from this
   browser"* — a different, truthful, actionable state — instead of a false "offline".
2. **A real path for web auth** (`supabase/functions/auth-broker` + `lib/rorkAuth.ts`): the app's
   own backend relays the three Rork Auth calls (`initiate`, `token`, `refresh`) server-to-server,
   where no CORS exists. On web the client calls
   `${EXPO_PUBLIC_SUPABASE_URL}/functions/v1/auth-broker/<action>` first and falls back to the
   direct call when the broker is not deployed (404/405) or unreachable — so native and
   Rork-allowlisted origins behave exactly as before, and no build breaks because of the change.

## To make web sign-in work everywhere (one deploy step)

The broker ships in this repo but, like every edge function, is not deployed by CI:

```bash
supabase functions deploy auth-broker   # uses the same login/access token as the other functions
```

Until it is deployed, web sign-in from non-allowlisted origins stays impossible (as it is today) —
but the app now says exactly that instead of claiming the member is offline.

## Security notes

- The relay forwards to exactly three fixed `api.rork.com` endpoints; it accepts no destination,
  adds no credential, and Rork's own app-key rejections (401/403) pass through unchanged.
- `verify_jwt = false` is deliberate: the browser calls it **before** any session exists, exactly
  like the direct calls it replaces.
- Bodies are JSON-checked before forwarding; responses are passed back byte-for-byte with the
  shared permissive CORS headers (`supabase/functions/_shared/cors.ts`), so any web origin the app
  is served from can use it.
