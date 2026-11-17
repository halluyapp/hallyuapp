import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const source = readFileSync('supabase/functions/_shared/operator/voice.ts', 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const { validateAudio, textChunks, geminiInteraction, outputContent } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const env = { SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-server-key', GEMINI_VOICE_API_KEY: 'test-gemini-key', GEMINI_VOICE_STT_MODEL: 'test-stt', GEMINI_VOICE_TTS_MODEL: 'test-tts' };
globalThis.Deno = { env: { get: (name) => env[name] }, serve: () => {} };
const { handleVoice } = await import(`data:text/javascript;base64,${Buffer.from(readFileSync('supabase/functions/_bundles/operator-voice.js')).toString('base64')}`);
const actor = '11111111-1111-4111-8111-111111111111';
const message = '22222222-2222-4222-8222-222222222222';
const originalFetch = globalThis.fetch;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const request = (body, auth = true) => new Request('https://edge.test', { method: 'POST', headers: auth ? { Authorization: 'Bearer test-user' } : {}, body: JSON.stringify(body) });
test('voice contracts (HTTP doubles; not real Gemini verification)', async (t) => {
  try {
    await t.test('audio validation rejects unsupported, malformed and oversized input', () => {
      for (const [data, mime] of [['@@@=', 'audio/webm'], ['', 'audio/wav'], ['YQ==', 'text/html'], ['YQ=='.repeat(1500000), 'audio/wav']]) assert.throws(() => validateAudio(data, mime));
      assert.equal(validateAudio('YQ==', 'audio/mp4').mime_type, 'audio/m4a');
    });
    await t.test('chunking preserves every character including long unbroken text', () => {
      for (const text of ['a'.repeat(20000), 'Hello world. '.repeat(1200)]) {
        const chunks = textChunks(text); assert.equal(chunks.join(''), text); assert.ok(chunks.every((s) => s.length <= 1800));
      }
    });
    await t.test('transport fixed endpoint, secret header, no storage and no fallback', async () => {
      let calls = 0;
      globalThis.fetch = async (url, options) => { calls++; assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/interactions'); assert.equal(options.headers['x-goog-api-key'], 'test'); assert.equal(JSON.parse(options.body).store, false); return json({}, 403); };
      await assert.rejects(geminiInteraction('test', { model: 'configured-only' }), { code: 'access_denied' }); assert.equal(calls, 1);
    });
    await t.test('incomplete responses fail and output ignores user input', async () => {
      globalThis.fetch = async () => json({ status: 'incomplete', steps: [] });
      await assert.rejects(geminiInteraction('test', {}), { code: 'incomplete_provider_response' });
      assert.deepEqual(outputContent({ steps: [{ type: 'user_input', content: [{ text: 'secret' }] }, { type: 'model_output', content: [{ type: 'text', text: 'hello' }] }] }), [{ type: 'text', text: 'hello' }]);
    });
    await t.test('missing auth performs no network calls', async () => {
      globalThis.fetch = async () => { throw new Error('must not call'); };
      assert.equal((await handleVoice(request({ action: 'transcribe' }, false))).status, 401);
    });
    let denied = false; let limited = false; let providerCalls = 0; let usageWrites = 0;
    const mockBackend = async (url, options = {}) => {
      const path = String(url);
      if (path.endsWith('/rpc/current_profile_id')) return json(actor);
      if (path.includes('/profiles?')) return json([{ id: actor, account_status: 'active' }]);
      if (path.includes('/direct_messages?')) return json(denied ? [] : [{ id: message, sender_id: actor, recipient_id: actor, body: 'Hello from Nari' }]);
      if (path.includes('/operator_staff?')) return json([{ profile_id: actor }]);
      if (path.endsWith('/rpc/operator_voice_reserve')) return limited ? json({ message: 'voice_limit_exceeded' }, 400) : json(message);
      if (path.includes('/operator_voice_request?')) { usageWrites++; return new Response(null, { status: 204 }); }
      if (path.includes('generativelanguage')) {
        providerCalls++;
        const payload = JSON.parse(options.body);
        return json({ status: 'completed', steps: [{ type: 'model_output', content: payload.response_format ? [{ type: 'audio', data: 'UklGRg==', mime_type: 'audio/wav' }] : [{ type: 'text', text: 'My spoken request' }] }], usage: { total_input_tokens: 4 } });
      }
      throw new Error(`unexpected request ${path}`);
    };
    await t.test('speech is transcribed without sending or executing reasoning', async () => {
      globalThis.fetch = mockBackend;
      const response = await handleVoice(request({ action: 'transcribe', audio_base64: 'YQ==', mime_type: 'audio/webm' }));
      assert.equal(response.status, 200); assert.equal((await response.json()).transcript, 'My spoken request'); assert.equal(providerCalls, 1); assert.equal(usageWrites, 1);
    });
    await t.test('another users message cannot be synthesized', async () => {
      denied = true;
      const response = await handleVoice(request({ action: 'synthesize', message_id: message }));
      assert.equal(response.status, 404); assert.equal(providerCalls, 1); denied = false;
    });
    await t.test('budget rejection is fail-closed before provider call', async () => {
      limited = true;
      assert.equal((await handleVoice(request({ action: 'transcribe', audio_base64: 'YQ==', mime_type: 'audio/webm' }))).status, 429);
      assert.equal(providerCalls, 1); limited = false;
    });
    await t.test('synthesis binds response to exact message and chunk', async () => {
      const response = await handleVoice(request({ action: 'synthesize', message_id: message }));
      const result = await response.json(); assert.equal(response.status, 200); assert.equal(result.message_id, message); assert.equal(result.chunk_count, 1); assert.equal(result.chunk_index, 0);
    });
  } finally { globalThis.fetch = originalFetch; }
});
