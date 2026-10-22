// Hallyu — Production Multi-Transport Push Notification Dispatcher
//
// Dispatches queued rows in `public.notification_deliveries` across all three real device targets:
//   1. Native Android Firebase Cloud Messaging HTTP v1 (`fcm:<deviceToken>`) via Google OAuth2 RS256
//   2. Apple iOS Home-Screen Web App & Desktop/Mobile W3C Web Push (`webpush:<subscriptionJson>`)
//      via RFC 8291 (`aes128gcm` ECDH P-256 + HKDF + AES-128-GCM) + RFC 8292 (`ES256` VAPID)
//   3. Expo Push Service (`ExponentPushToken[...]`)
//
// Reads server credentials from function environment OR cached `public.ci_build_vault` (`service_role`).

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}

const SUPABASE_URL = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/$/, '');
const SERVICE_KEY_ENV = ['SUPABASE', 'SERVICE', 'ROLE', 'KEY'].join('_');
const SERVICE_KEY = Deno.env.get(SERVICE_KEY_ENV) ?? '';
const EXPO_PUSH_URL = Deno.env.get('EXPO_PUSH_URL') ?? 'https://exp.host/--/api/v2/push/send';
const EXPO_ACCESS_TOKEN = Deno.env.get('EXPO_ACCESS_TOKEN') ?? '';
const MAX_BATCH = 100;

function requireServiceRole(request: Request): { ok: true } | { ok: false; response: Response } {
  const header = request.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  if (!token || token !== SERVICE_KEY) {
    return {
      ok: false,
      response: new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
    };
  }
  return { ok: true };
}

async function rpc<T>(
  fn: string,
  params: Record<string, unknown> = {},
): Promise<{ data: T | null; error: { message: string } | null }> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'x-application-name': 'hallyu-edge',
    },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { data: null, error: { message: text.slice(0, 300) || `HTTP ${res.status}` } };
  }
  const text = await res.text();
  return { data: (text ? JSON.parse(text) : null) as T, error: null };
}

// ---------------------------------------------------------------------------------------------
// Cached Server Credential Loader (`Deno.env` + `public.ci_build_vault`)
// ---------------------------------------------------------------------------------------------

interface RuntimeSecrets {
  fcmServiceAccount: {
    project_id: string;
    client_email: string;
    private_key: string;
    token_uri?: string;
  } | null;
  vapidPublicKey: string;
  vapidJwkPrivate: JsonWebKey | null;
  vapidSubject: string;
  loadedAt: number;
}

let cachedSecrets: RuntimeSecrets | null = null;
let cachedGoogleAccessToken: { token: string; expiresAt: number } | null = null;

async function loadSecrets(): Promise<RuntimeSecrets> {
  if (cachedSecrets && Date.now() - cachedSecrets.loadedAt < 5 * 60_000) {
    return cachedSecrets;
  }

  const vaultMap = new Map<string, string>();
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/ci_build_vault?select=key,value&key=in.(fcm_service_account_json,vapid_public_key,vapid_jwk_private,vapid_subject)`,
      {
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          Accept: 'application/json',
        },
      },
    );
    if (res.ok) {
      const rows = (await res.json()) as Array<{ key: string; value: string }>;
      for (const r of rows) vaultMap.set(r.key, r.value);
    }
  } catch {
    // Fallback to env if table unavailable
  }

  const fcmRaw = (Deno.env.get('FCM_SERVICE_ACCOUNT_JSON') || vaultMap.get('fcm_service_account_json') || '').trim();
  let fcmServiceAccount: RuntimeSecrets['fcmServiceAccount'] = null;
  if (fcmRaw) {
    try {
      const parsed = JSON.parse(fcmRaw);
      if (parsed?.project_id && parsed?.client_email && parsed?.private_key) {
        fcmServiceAccount = parsed;
      }
    } catch {
      fcmServiceAccount = null;
    }
  }

  const vapidPublicKey = (Deno.env.get('VAPID_PUBLIC_KEY') || vaultMap.get('vapid_public_key') || '').trim();
  const vapidPrivRaw = (Deno.env.get('VAPID_JWK_PRIVATE') || vaultMap.get('vapid_jwk_private') || '').trim();
  let vapidJwkPrivate: JsonWebKey | null = null;
  if (vapidPrivRaw) {
    try {
      vapidJwkPrivate = JSON.parse(vapidPrivRaw) as JsonWebKey;
    } catch {
      vapidJwkPrivate = null;
    }
  }
  const vapidSubject =
    (Deno.env.get('VAPID_SUBJECT') || vaultMap.get('vapid_subject') || 'mailto:fixhallyu@gmail.com').trim();

  cachedSecrets = {
    fcmServiceAccount,
    vapidPublicKey,
    vapidJwkPrivate,
    vapidSubject,
    loadedAt: Date.now(),
  };
  return cachedSecrets;
}

// ---------------------------------------------------------------------------------------------
// Base64URL & Binary Helpers
// ---------------------------------------------------------------------------------------------

const te = new TextEncoder();

function b64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function pemToDer(pem: string): ArrayBuffer {
  const clean = pem
    .replace(/-----BEGIN [A-Z0-9 ]+-----/g, '')
    .replace(/-----END [A-Z0-9 ]+-----/g, '')
    .replace(/\s+/g, '');
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

// ---------------------------------------------------------------------------------------------
// 1. Native Android Firebase FCM HTTP v1 Transport
// ---------------------------------------------------------------------------------------------

async function getGoogleAccessToken(
  sa: NonNullable<RuntimeSecrets['fcmServiceAccount']>,
): Promise<string> {
  if (cachedGoogleAccessToken && Date.now() < cachedGoogleAccessToken.expiresAt) {
    return cachedGoogleAccessToken.token;
  }

  const now = Math.floor(Date.now() / 1000);
  const tokenUri = sa.token_uri || 'https://oauth2.googleapis.com/token';
  const header = b64urlEncode(te.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claim = b64urlEncode(
    te.encode(
      JSON.stringify({
        iss: sa.client_email,
        scope: 'https://www.googleapis.com/auth/firebase.messaging',
        aud: tokenUri,
        iat: now,
        exp: now + 3600,
      }),
    ),
  );
  const unsigned = `${header}.${claim}`;
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, te.encode(unsigned)),
  );
  const assertion = `${unsigned}.${b64urlEncode(sig)}`;

  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Google OAuth2 failed (${res.status}): ${errText.slice(0, 200)}`);
  }

  const tokenData = (await res.json()) as { access_token: string; expires_in?: number };
  cachedGoogleAccessToken = {
    token: tokenData.access_token,
    expiresAt: Date.now() + Math.max((tokenData.expires_in ?? 3600) - 180, 60) * 1000,
  };
  return cachedGoogleAccessToken.token;
}

interface ClaimedDelivery {
  delivery_id: string;
  notification_id: string;
  push_token_id: string;
  token: string;
  platform: 'ios' | 'android' | 'web';
  attempt: number;
  title: string;
  body: string;
  deep_link: string;
  payload: Record<string, unknown>;
}

interface ProviderResult {
  ok: boolean;
  status: number | string;
  id?: string;
  details?: unknown;
  message?: string;
}

function channelForPayload(payload: Record<string, unknown>): 'episodes' | 'social' | 'system' {
  const kind = String(payload?.kind ?? payload?.type ?? '').toLowerCase();
  if (kind.includes('episode') || kind.includes('title_status')) return 'episodes';
  if (kind.includes('system') || kind.includes('moderation') || kind.includes('test_push')) {
    return 'system';
  }
  return 'social';
}

async function sendFcmSingle(
  delivery: ClaimedDelivery,
  sa: NonNullable<RuntimeSecrets['fcmServiceAccount']>,
): Promise<ProviderResult> {
  const rawDeviceToken = delivery.token.startsWith('fcm:')
    ? delivery.token.slice(4).trim()
    : delivery.token.trim();
  const accessToken = await getGoogleAccessToken(sa);
  const channelId = channelForPayload(delivery.payload ?? {});
  const dataStrings: Record<string, string> = {
    url: delivery.deep_link || '/notifications',
    deep_link: delivery.deep_link || '/notifications',
    notification_id: String(delivery.notification_id ?? ''),
    delivery_id: String(delivery.delivery_id ?? ''),
    title: delivery.title || 'Hallyu',
    body: delivery.body || '',
  };
  for (const [k, v] of Object.entries(delivery.payload ?? {})) {
    if (v !== undefined && v !== null) {
      dataStrings[k] = typeof v === 'string' ? v : JSON.stringify(v);
    }
  }

  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          token: rawDeviceToken,
          notification: {
            title: delivery.title || 'Hallyu',
            body: delivery.body || '',
          },
          data: dataStrings,
          android: {
            priority: 'HIGH',
            ttl: '86400s',
            notification: {
              channel_id: channelId,
              sound: 'default',
              default_vibrate_timings: true,
              visibility: 'PUBLIC',
            },
          },
        },
      }),
    },
  );

  const text = await res.text().catch(() => '');
  if (res.ok) {
    try {
      const parsed = JSON.parse(text) as { name?: string };
      return { ok: true, status: res.status, id: parsed.name };
    } catch {
      return { ok: true, status: res.status };
    }
  }
  return {
    ok: false,
    status: res.status,
    details: text.slice(0, 260),
    message: text.slice(0, 260),
  };
}

// ---------------------------------------------------------------------------------------------
// 2. W3C Web Push Transport (Apple iOS 16.4–18+ Home-Screen PWA + Chrome/Edge/Firefox)
//    Implements RFC 8291 (`aes128gcm`) + RFC 8292 (`vapid` ES256) with zero external packages.
// ---------------------------------------------------------------------------------------------

async function hkdfExtractAndExpand(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const baseKey = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    baseKey,
    length * 8,
  );
  return new Uint8Array(bits);
}

async function encryptWebPushPayload(
  plaintext: Uint8Array,
  uaPublicKeyB64: string,
  authSecretB64: string,
): Promise<Uint8Array> {
  const uaPublicBytes = b64urlDecode(uaPublicKeyB64);
  const authSecret = b64urlDecode(authSecretB64);

  const uaKey = await crypto.subtle.importKey(
    'raw',
    uaPublicBytes,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const asKeyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  );
  const asPublicBytes = new Uint8Array(
    await crypto.subtle.exportKey('raw', asKeyPair.publicKey),
  );
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'ECDH', public: uaKey },
      asKeyPair.privateKey,
      256,
    ),
  );

  const keyInfo = concatBytes(te.encode('WebPush: info\0'), uaPublicBytes, asPublicBytes);
  const ikm = await hkdfExtractAndExpand(authSecret, ecdhSecret, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdfExtractAndExpand(
    salt,
    ikm,
    te.encode('Content-Encoding: aes128gcm\0'),
    16,
  );
  const nonce = await hkdfExtractAndExpand(
    salt,
    ikm,
    te.encode('Content-Encoding: nonce\0'),
    12,
  );

  // RFC 8291 record delimiter (0x02 final record)
  const paddedPlain = concatBytes(plaintext, new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, paddedPlain),
  );

  // 86-byte `aes128gcm` header: salt(16) || rs(4, 4096 BE) || idlen(1, 65) || keyid(65)
  const rs = new Uint8Array([0, 0, 16, 0]);
  const idlen = new Uint8Array([asPublicBytes.length]);
  return concatBytes(salt, rs, idlen, asPublicBytes, ciphertext);
}

async function createVapidAuthHeader(
  endpoint: string,
  vapidSubject: string,
  vapidPublicKey: string,
  vapidJwkPrivate: JsonWebKey,
): Promise<string> {
  const origin = new URL(endpoint).origin;
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlEncode(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64urlEncode(
    te.encode(
      JSON.stringify({
        aud: origin,
        exp: now + 12 * 3600,
        sub: vapidSubject,
      }),
    ),
  );
  const unsigned = `${header}.${payload}`;
  const ecKey = await crypto.subtle.importKey(
    'jwk',
    vapidJwkPrivate,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, ecKey, te.encode(unsigned)),
  );
  return `vapid t=${unsigned}.${b64urlEncode(sig)}, k=${vapidPublicKey}`;
}

async function sendWebPushSingle(
  delivery: ClaimedDelivery,
  secrets: RuntimeSecrets,
): Promise<ProviderResult> {
  if (!secrets.vapidPublicKey || !secrets.vapidJwkPrivate) {
    return { ok: false, status: 500, message: 'VAPID keys not configured' };
  }
  const jsonRaw = delivery.token.startsWith('webpush:')
    ? delivery.token.slice('webpush:'.length)
    : delivery.token;

  let sub: { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  try {
    sub = JSON.parse(jsonRaw);
  } catch {
    return { ok: false, status: 400, details: 'UNREGISTERED malformed webpush token', message: 'UNREGISTERED' };
  }

  if (!sub.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
    return { ok: false, status: 400, details: 'UNREGISTERED incomplete webpush keys', message: 'UNREGISTERED' };
  }

  const messagePayload = JSON.stringify({
    title: delivery.title || 'Hallyu',
    body: delivery.body || '',
    url: delivery.deep_link || '/notifications',
    tag: String(delivery.notification_id || 'hallyu'),
    data: {
      ...delivery.payload,
      url: delivery.deep_link || '/notifications',
    },
  });

  const bodyBytes = await encryptWebPushPayload(
    te.encode(messagePayload),
    sub.keys.p256dh,
    sub.keys.auth,
  );
  const authHeader = await createVapidAuthHeader(
    sub.endpoint,
    secrets.vapidSubject,
    secrets.vapidPublicKey,
    secrets.vapidJwkPrivate,
  );

  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: authHeader,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '86400',
      Urgency: 'high',
    },
    body: bodyBytes,
  });

  if (res.status >= 200 && res.status < 300) {
    return {
      ok: true,
      status: res.status,
      id: res.headers.get('location') ?? `webpush:${res.status}`,
    };
  }

  const errText = await res.text().catch(() => '');
  const gone = res.status === 404 || res.status === 410 ? 'UNREGISTERED ' : '';
  return {
    ok: false,
    status: res.status,
    details: `${gone}${errText}`.slice(0, 240),
    message: `${gone}HTTP ${res.status}`,
  };
}

// ---------------------------------------------------------------------------------------------
// 3. Expo Push Service Transport (`ExponentPushToken[...]`)
// ---------------------------------------------------------------------------------------------

function buildExpoMessage(delivery: ClaimedDelivery): Record<string, unknown> {
  const channelId = channelForPayload(delivery.payload ?? {});
  return {
    to: delivery.token,
    title: delivery.title || 'Hallyu',
    body: delivery.body || '',
    sound: 'default',
    priority: 'high',
    ttl: 86400,
    channelId: delivery.platform === 'android' ? channelId : undefined,
    data: {
      ...delivery.payload,
      url: delivery.deep_link || '/notifications',
      deep_link: delivery.deep_link || '/notifications',
      notification_id: delivery.notification_id,
      delivery_id: delivery.delivery_id,
    },
  };
}

function isInvalidToken(details: unknown, message?: string): boolean {
  const text = `${JSON.stringify(details ?? '')} ${message ?? ''}`.toUpperCase();
  return (
    text.includes('DEVICENOTREGISTERED') ||
    text.includes('DEVICE_NOT_REGISTERED') ||
    text.includes('NOTREGISTERED') ||
    text.includes('INVALIDTOK') ||
    text.includes('INVALID_TOKEN') ||
    text.includes('INVALID_ARGUMENT') ||
    text.includes('APNS_ERROR') ||
    text.includes('SENDERIDMISMATCH') ||
    text.includes('UNREGISTERED') ||
    text.includes('NOT A VALID EXPO PUSH TOKEN')
  );
}

async function sendExpoBatch(deliveries: ClaimedDelivery[]): Promise<ProviderResult[]> {
  if (deliveries.length === 0) return [];
  const messages = deliveries.map(buildExpoMessage);
  const response = await fetch(EXPO_PUSH_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Accept-encoding': 'gzip, deflate',
      'Content-Type': 'application/json',
      ...(EXPO_ACCESS_TOKEN ? { Authorization: `Bearer ${EXPO_ACCESS_TOKEN}` } : {}),
    },
    body: JSON.stringify(messages),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    return messages.map(() => ({
      ok: false,
      status: response.status,
      details: text.slice(0, 200),
      message: text.slice(0, 200),
    }));
  }

  const payload = (await response.json()) as {
    data?: Array<{ status: number | string; id?: string; details?: unknown; message?: string }>;
  };
  const results = payload.data ?? [];
  return messages.map((_, index) => {
    const r = results[index];
    if (!r) return { ok: false, status: 502, details: 'truncated provider response' };
    const accepted = r.status === 'ok' || r.status === 200;
    return {
      ok: accepted,
      status: r.status,
      id: r.id,
      details: r.details,
      message: r.message,
    };
  });
}

async function recordOutcome(
  delivery: ClaimedDelivery,
  outcome: ProviderResult,
  counters: { sent: number; failed: number; invalid: number },
): Promise<void> {
  const details =
    typeof outcome.details === 'string'
      ? outcome.details
      : JSON.stringify(outcome.details ?? outcome.message ?? '');

  if (outcome.ok) {
    counters.sent += 1;
    await rpc('report_delivery', {
      p_delivery_id: delivery.delivery_id,
      p_sent: true,
      p_error: null,
      p_invalid: false,
      p_provider_message_id: outcome.id ?? null,
    });
    return;
  }

  if (isInvalidToken(outcome.details, outcome.message)) {
    counters.invalid += 1;
    await rpc('report_delivery', {
      p_delivery_id: delivery.delivery_id,
      p_sent: false,
      p_error: `${details} ${outcome.message ?? ''}`.trim().slice(0, 300),
      p_invalid: true,
      p_provider_message_id: outcome.id ?? null,
    });
    return;
  }

  counters.failed += 1;
  await rpc('report_delivery', {
    p_delivery_id: delivery.delivery_id,
    p_sent: false,
    p_error: `${outcome.status}: ${details} ${outcome.message ?? ''}`.trim().slice(0, 300),
    p_invalid: false,
    p_provider_message_id: outcome.id ?? null,
  });
}

// ---------------------------------------------------------------------------------------------
// Edge Entrypoint
// ---------------------------------------------------------------------------------------------

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const guard = requireServiceRole(request);
  if (!guard.ok) return guard.response;

  let body: { limit?: number; max_attempts?: number; verify_fcm?: boolean; reload_secrets?: boolean } = {};
  if (request.method === 'POST') {
    try {
      body = await request.json();
    } catch {
      // Empty scheduled cron payload is normal.
    }
  }

  if (body.reload_secrets) cachedSecrets = null;

  try {
    const secrets = await loadSecrets();
    let fcmTokenVerified = false;
    if (body.verify_fcm && secrets.fcmServiceAccount) {
      const accessToken = await getGoogleAccessToken(secrets.fcmServiceAccount);
      fcmTokenVerified = Boolean(accessToken && accessToken.length > 20);
    }

  const limit = Math.min(Math.max(body.limit ?? MAX_BATCH, 1), MAX_BATCH);

  const { error: fanoutError } = await rpc('fanout_due_notifications', { p_limit: 500 });
  if (fanoutError) return errorResponse(`fan-out failed: ${fanoutError.message}`, 500);

  const { data, error: claimError } = await rpc<ClaimedDelivery[]>('claim_notification_deliveries', {
    p_limit: limit,
    p_max_attempts: body.max_attempts ?? 5,
  });
  if (claimError) return errorResponse(`could not claim deliveries: ${claimError.message}`, 500);

  const claimed = data ?? [];
  if (claimed.length === 0) {
    return jsonResponse({
      claimed: 0,
      sent: 0,
      failed: 0,
      invalid: 0,
      configured: true,
      fcm_configured: Boolean(secrets.fcmServiceAccount),
      fcm_project_id: secrets.fcmServiceAccount?.project_id ?? null,
      fcm_oauth_verified: fcmTokenVerified,
      webpush_configured: Boolean(secrets.vapidPublicKey && secrets.vapidJwkPrivate),
    });
  }

  const counters = { sent: 0, failed: 0, invalid: 0 };
  const expoDeliveries: ClaimedDelivery[] = [];

  for (const delivery of claimed) {
    if (delivery.token.startsWith('fcm:')) {
      if (!secrets.fcmServiceAccount) {
        await recordOutcome(
          delivery,
          { ok: false, status: 500, message: 'FCM service account missing in vault' },
          counters,
        );
        continue;
      }
      try {
        const outcome = await sendFcmSingle(delivery, secrets.fcmServiceAccount);
        await recordOutcome(delivery, outcome, counters);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await recordOutcome(delivery, { ok: false, status: 502, message: msg }, counters);
      }
      continue;
    }

    if (delivery.token.startsWith('webpush:') || delivery.token.startsWith('{')) {
      try {
        const outcome = await sendWebPushSingle(delivery, secrets);
        await recordOutcome(delivery, outcome, counters);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await recordOutcome(delivery, { ok: false, status: 502, message: msg }, counters);
      }
      continue;
    }

    expoDeliveries.push(delivery);
  }

  if (expoDeliveries.length > 0) {
    try {
      const results = await sendExpoBatch(expoDeliveries);
      for (let i = 0; i < expoDeliveries.length; i += 1) {
        const delivery = expoDeliveries[i]!;
        const outcome = results[i] ?? { ok: false, status: 502, details: 'missing provider response' };
        await recordOutcome(delivery, outcome, counters);
      }
    } catch (networkError) {
      const message = networkError instanceof Error ? networkError.message : String(networkError);
      for (const delivery of expoDeliveries) {
        await recordOutcome(
          delivery,
          { ok: false, status: 502, message: `provider unreachable: ${message}` },
          counters,
        );
      }
    }
  }

    return jsonResponse({
      claimed: claimed.length,
      sent: counters.sent,
      failed: counters.failed,
      invalid: counters.invalid,
      disabled_tokens_today: counters.invalid,
      fcm_configured: Boolean(secrets.fcmServiceAccount),
      webpush_configured: Boolean(secrets.vapidPublicKey && secrets.vapidJwkPrivate),
    });
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return errorResponse(msg, 500);
  }
});
