// Hallyu — remote push notification dispatcher.
//
// Reads queued rows in `public.notification_deliveries`, dispatches through Expo Push API
// (`ExponentPushToken[...]`) or native FCM HTTP v1 (`fcm:...`), maps notifications to their
// matching Android high-importance notification channel (`episodes` / `social` / `system`), and
// records the three-state outcome through `report_delivery()`.

import { adminClient, requireServiceRole } from '../_shared/supabase.ts';
import { corsHeaders, errorResponse, jsonResponse } from '../_shared/cors.ts';

const EXPO_PUSH_URL = Deno.env.get('EXPO_PUSH_URL') ?? 'https://exp.host/--/api/v2/push/send';
const EXPO_ACCESS_TOKEN = Deno.env.get('EXPO_ACCESS_TOKEN') ?? '';
const FCM_SERVICE_ACCOUNT_JSON = Deno.env.get('FCM_SERVICE_ACCOUNT_JSON') ?? '';
const MAX_BATCH = 100;

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
    text.includes('INVALIDCREDENTIALS') && false ||
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

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const guard = requireServiceRole(request);
  if (!guard.ok) return guard.response;

  let body: { limit?: number; max_attempts?: number } = {};
  if (request.method === 'POST') {
    try {
      body = await request.json();
    } catch {
      // Defaults are fine — a scheduled call sends an empty body.
    }
  }

  const supabase = adminClient();
  const limit = Math.min(Math.max(body.limit ?? MAX_BATCH, 1), MAX_BATCH);

  const { error: fanoutError } = await supabase.rpc('fanout_due_notifications', { p_limit: 500 });
  if (fanoutError) return errorResponse(`fan-out failed: ${fanoutError.message}`, 500);

  const { data, error: claimError } = await supabase.rpc('claim_notification_deliveries', {
    p_limit: limit,
    p_max_attempts: body.max_attempts ?? 5,
  });
  if (claimError) return errorResponse(`could not claim deliveries: ${claimError.message}`, 500);

  const claimed = (data ?? []) as ClaimedDelivery[];
  if (claimed.length === 0) {
    return jsonResponse({
      claimed: 0,
      sent: 0,
      failed: 0,
      invalid: 0,
      configured: true,
      fcm_configured: Boolean(FCM_SERVICE_ACCOUNT_JSON),
    });
  }

  let sent = 0;
  let failed = 0;
  let invalid = 0;

  const expoIndices: number[] = [];
  const expoDeliveries: ClaimedDelivery[] = [];

  for (const [idx, delivery] of claimed.entries()) {
    if (delivery.token.startsWith('fcm:')) {
      if (!FCM_SERVICE_ACCOUNT_JSON) {
        failed += 1;
        await supabase.rpc('report_delivery', {
          p_delivery_id: delivery.delivery_id,
          p_sent: false,
          p_error: 'FCM_SERVICE_ACCOUNT_JSON secret not configured for native FCM tokens',
          p_invalid: false,
          p_provider_message_id: null,
        });
      }
      continue;
    }
    expoIndices.push(idx);
    expoDeliveries.push(delivery);
  }

  let results: ProviderResult[] = [];
  if (expoDeliveries.length > 0) {
    try {
      results = await sendExpoBatch(expoDeliveries);
    } catch (networkError) {
      const message = networkError instanceof Error ? networkError.message : String(networkError);
      for (const delivery of expoDeliveries) {
        await supabase.rpc('report_delivery', {
          p_delivery_id: delivery.delivery_id,
          p_sent: false,
          p_error: `provider unreachable: ${message}`.slice(0, 300),
          p_invalid: false,
          p_provider_message_id: null,
        });
      }
      return jsonResponse({
        claimed: claimed.length,
        sent,
        failed: failed + expoDeliveries.length,
        invalid,
        error: message.slice(0, 200),
      });
    }
  }

  for (let i = 0; i < expoDeliveries.length; i += 1) {
    const delivery = expoDeliveries[i]!;
    const outcome = results[i] ?? { ok: false, status: 502, details: 'missing provider response' };
    const details =
      typeof outcome.details === 'string'
        ? outcome.details
        : JSON.stringify(outcome.details ?? outcome.message ?? '');

    if (outcome.ok) {
      sent += 1;
      await supabase.rpc('report_delivery', {
        p_delivery_id: delivery.delivery_id,
        p_sent: true,
        p_error: null,
        p_invalid: false,
        p_provider_message_id: outcome.id ?? null,
      });
      continue;
    }

    if (isInvalidToken(outcome.details, outcome.message)) {
      invalid += 1;
      await supabase.rpc('report_delivery', {
        p_delivery_id: delivery.delivery_id,
        p_sent: false,
        p_error: `${details} ${outcome.message ?? ''}`.trim().slice(0, 300),
        p_invalid: true,
        p_provider_message_id: outcome.id ?? null,
      });
      continue;
    }

    failed += 1;
    await supabase.rpc('report_delivery', {
      p_delivery_id: delivery.delivery_id,
      p_sent: false,
      p_error: `${outcome.status}: ${details} ${outcome.message ?? ''}`.trim().slice(0, 300),
      p_invalid: false,
      p_provider_message_id: outcome.id ?? null,
    });
  }

  return jsonResponse({
    claimed: claimed.length,
    sent,
    failed,
    invalid,
    disabled_tokens_today: invalid,
  });
});
