// Provider adapters for the Hallyu AI Operator.
//
// Two providers, two credentials, two credit pools, two health states. There is deliberately
// NO fallback path in this module: `callProvider` resolves exactly one provider from the task's
// assigned provider id and either returns that provider's answer or throws. It never tries the
// other provider, never retries across providers, and never silently downgrades a model.
// Switching providers is a policy decision made in the database (`operator_set_active_model`),
// not something the transport layer may do on failure.

export type ProviderId = 'apinex' | 'coarena';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolSchema {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatRequest {
  provider: ProviderId;
  model: string;
  messages: ChatMessage[];
  tools?: ToolSchema[];
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface ChatUsage {
  input: number;
  output: number;
  total: number;
}

export interface ChatResult {
  provider: ProviderId;
  model: string;
  content: string;
  toolCalls: ToolCall[];
  usage: ChatUsage;
  latencyMs: number;
  httpStatus: number;
  finishReason: string;
}

export class ProviderError extends Error {
  readonly provider: ProviderId;
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;

  constructor(provider: ProviderId, message: string, status: number, code: string, retryable: boolean) {
    super(message);
    this.name = 'ProviderError';
    this.provider = provider;
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

interface ProviderRuntime {
  id: ProviderId;
  baseUrl: string;
  apiKeyEnv: string;
}

// The base URLs are fixed here on purpose. They are not read from the request, so a task cannot
// point the operator at an arbitrary endpoint.
const PROVIDERS: Record<ProviderId, ProviderRuntime> = {
  apinex: { id: 'apinex', baseUrl: 'https://api.apinex.bond/v1', apiKeyEnv: 'APINEX_API_KEY' },
  coarena: { id: 'coarena', baseUrl: 'https://coarena.ai/api/v1', apiKeyEnv: 'COARENA_API_KEY' },
};

export function isProviderId(value: unknown): value is ProviderId {
  return value === 'apinex' || value === 'coarena';
}

// Credentials live server-side only. Preferred source is the Edge Function secret
// (`APINEX_API_KEY` / `COARENA_API_KEY`). If that is not set, we fall back to Supabase Vault via a
// service-role-only RPC, so the keys are never committed to the repository and never reach a
// client. The fallback still resolves exactly one provider — there is no cross-provider lookup.
async function vaultCredential(provider: ProviderId): Promise<string | null> {
  const url = (Deno.env.get('SUPABASE_URL') ?? '').trim();
  const serviceKey = (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '').trim();
  if (!url || !serviceKey) return null;
  try {
    const response = await fetch(`${url}/rest/v1/rpc/operator_provider_secret`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({ p_provider: provider }),
    });
    if (!response.ok) return null;
    const value = (await response.json()) as unknown;
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

export async function providerCredential(provider: ProviderId): Promise<string> {
  const runtime = PROVIDERS[provider];
  const envKey = (Deno.env.get(runtime.apiKeyEnv) ?? '').trim();
  if (envKey) return envKey;
  const vaultKey = await vaultCredential(provider);
  if (vaultKey) return vaultKey;
  throw new ProviderError(provider, `${runtime.apiKeyEnv} is not configured`, 0, 'missing_credential', false);
}

/**
 * Classify a provider failure. A 403 with an HTML body is an edge/WAF block, not a credential
 * problem: treating it as `auth_error` permanently failed good tasks (and hid the real cause).
 */
function classifyStatus(status: number, body: string): { code: string; retryable: boolean } {
  const looksLikeHtml = /^\s*</.test(body);
  if (status === 401) return { code: 'auth_error', retryable: false };
  if (status === 403) {
    return looksLikeHtml
      ? { code: 'provider_blocked', retryable: true }
      : { code: 'auth_error', retryable: false };
  }
  if (status === 402) return { code: 'billing_error', retryable: false };
  if (status === 429) return { code: 'rate_limited', retryable: true };
  if (status === 408 || status === 504) return { code: 'timeout', retryable: true };
  if (status >= 500) return { code: 'provider_unavailable', retryable: true };
  if (status >= 400) return { code: 'bad_request', retryable: false };
  return { code: 'unknown', retryable: false };
}

/**
 * Call exactly one provider. Throws `ProviderError` on any failure — it will never attempt the
 * other provider. The caller records usage against `request.provider` whether this resolves or
 * rejects, so each provider's credit pool stays independently accounted.
 */
export async function callProvider(request: ChatRequest): Promise<ChatResult> {
  if (!isProviderId(request.provider)) {
    throw new ProviderError('apinex', `unknown provider: ${String(request.provider)}`, 0, 'unknown_provider', false);
  }
  const runtime = PROVIDERS[request.provider];
  // Must be awaited: the Vault lookup is async, and an unawaited call put
  // "Bearer [object Promise]" in the Authorization header of every completion.
  const apiKey = await providerCredential(request.provider);
  const timeoutMs = Math.min(Math.max(request.timeoutMs ?? 45_000, 5_000), 120_000);

  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages,
    temperature: request.temperature ?? 0.6,
    max_tokens: request.maxTokens ?? 1_400,
    stream: false,
  };
  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools;
    body.tool_choice = 'auto';
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(`${runtime.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'x-application-name': 'hallyu-operator',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    const aborted = error instanceof Error && error.name === 'AbortError';
    throw new ProviderError(
      request.provider,
      aborted ? `request timed out after ${timeoutMs}ms` : `network error: ${(error as Error).message}`,
      0,
      aborted ? 'timeout' : 'network_error',
      true,
    );
  }
  clearTimeout(timer);
  const latencyMs = Date.now() - startedAt;

  const text = await response.text().catch(() => '');
  if (!response.ok) {
    const { code, retryable } = classifyStatus(response.status, text);
    throw new ProviderError(
      request.provider,
      `${request.provider} HTTP ${response.status}: ${text.slice(0, 400)}`,
      response.status,
      code,
      retryable,
    );
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new ProviderError(request.provider, `${request.provider} returned non-JSON`, response.status, 'bad_response', true);
  }

  const choices = Array.isArray(payload.choices) ? (payload.choices as Array<Record<string, unknown>>) : [];
  const first = choices[0] ?? {};
  const message = (first.message ?? {}) as Record<string, unknown>;
  const rawToolCalls = Array.isArray(message.tool_calls) ? (message.tool_calls as ToolCall[]) : [];
  const usageRaw = (payload.usage ?? {}) as Record<string, number>;
  const input = Number(usageRaw.prompt_tokens ?? 0) || 0;
  const output = Number(usageRaw.completion_tokens ?? 0) || 0;

  return {
    provider: request.provider,
    model: String(payload.model ?? request.model),
    content: typeof message.content === 'string' ? message.content : '',
    toolCalls: rawToolCalls.filter((call) => call && call.type === 'function' && call.function?.name),
    usage: { input, output, total: Number(usageRaw.total_tokens ?? input + output) || input + output },
    latencyMs,
    httpStatus: response.status,
    finishReason: String(first.finish_reason ?? 'stop'),
  };
}

/**
 * Reachability probe used by the health monitor. This deliberately does NOT call the billable
 * chat-completions endpoint: it issues an authenticated GET against the models endpoint, which
 * proves the credential and network path without consuming completion credits.
 */
export async function probeProvider(provider: ProviderId, model: string): Promise<{ ok: boolean; status: number; detail: string }> {
  const runtime = PROVIDERS[provider];
  try {
    const apiKey = await providerCredential(provider);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let response: Response;
    try {
      response = await fetch(`${runtime.baseUrl}/models`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (response.ok) return { ok: true, status: response.status, detail: `models ok (${model})` };
    const text = (await response.text().catch(() => '')).slice(0, 160);
    return { ok: false, status: response.status, detail: text || `HTTP ${response.status}` };
  } catch (error) {
    if (error instanceof ProviderError) return { ok: false, status: error.status, detail: `${error.code}: ${error.message.slice(0, 160)}` };
    return { ok: false, status: 0, detail: (error as Error).message.slice(0, 160) };
  }
}
