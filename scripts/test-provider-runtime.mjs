import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { readFileSync } from 'node:fs';
const source = readFileSync('supabase/functions/_shared/operator/providers.ts', 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const { callProvider, probeProvider, classifyStatus } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
globalThis.Deno = { env: { get: () => 'test-only-credential' } };
const originalFetch = globalThis.fetch;
const mock = (payload, status = 200) => { globalThis.fetch = async () => new Response(JSON.stringify(payload), { status }); };
const request = { provider: 'apinex', model: 'test-model', messages: [{ role: 'user', content: 'hello' }] };
test('provider runtime contracts (test doubles, not provider availability)', async (t) => {
  try {
    await t.test('classification separates access, billing, limits and outage', () => {
      for (const [status, body, code] of [[401, '', 'auth_error'], [403, '{}', 'permission_denied'], [402, '', 'billing_error'], [429, 'insufficient_quota', 'billing_error'], [429, '', 'rate_limited'], [503, '', 'provider_unavailable'], [404, '', 'model_unavailable'], [400, 'maximum context length exceeded', 'context_limit_exceeded']]) assert.equal(classifyStatus(status, body).code, code);
    });
    await t.test('malformed success cannot become assistant response', async () => {
      for (const payload of [{}, { choices: [] }, { choices: [{ message: { tool_calls: [{ type: 'function', function: { name: 'post.publish' } }] } }] }]) {
        mock(payload);
        await assert.rejects(callProvider(request), { code: 'bad_response' });
      }
    });
    await t.test('valid content and reported usage preserved', async () => {
      mock({ choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } });
      const result = await callProvider(request);
      assert.equal(result.content, 'hello'); assert.equal(result.usage.total, 5);
    });
    await t.test('health requires selected model and does not claim generation', async () => {
      mock({ data: [{ id: 'other' }] }); assert.equal((await probeProvider('apinex', 'test-model')).ok, false);
      mock({ data: [{ id: 'test-model' }] }); const result = await probeProvider('apinex', 'test-model');
      assert.equal(result.ok, true); assert.match(result.detail, /generation and capabilities unverified/);
    });
    await t.test('failure never invokes another provider', async () => {
      let calls = 0;
      globalThis.fetch = async (url) => { calls++; assert.match(url, /api\.apinex\.bond/); return new Response('', { status: 402 }); };
      await assert.rejects(callProvider(request), { code: 'billing_error', retryable: false }); assert.equal(calls, 1);
    });
  } finally { globalThis.fetch = originalFetch; }
});
