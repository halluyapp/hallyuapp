# Current integration evidence — 2026-11-17

This section supersedes historical Stage2 deployment/transport statements below.
Production operator-voice v9 is deployed from cbef61f. Dedicated Gemini
`generateContent` is the default; `GEMINI_VOICE_STT_TRANSPORT=interactions` is an
explicit opt-in, not an automatic fallback. Current STT model is
`gemini-3.5-transcribe`; TTS is `gemini-2.5-flash-preview-tts`.

Real authenticated production probes repeatedly generated WAV speech successfully.
PCM-to-WAV byte lengths/sample-rate headers also pass the local contract test.
**Transcription is not accepted:** smoke ledger
`0644c866-4577-46a2-ad60-9feb0540fd0a` received empty text directly from the
configured STT model and the authenticated endpoint correctly returned422
`no_speech_detected`. Earlier explicit models returned retired-model404,
timeout or provider503 high demand. No fallback or fabricated transcript was used.
All isolated fixture cleanup checks passed.

Microphone capture, actual speaker playback, cancellation and low-end Android
resource use remain physical-device acceptance gaps. Live voice is not
implemented. Configuration status deliberately retains readiness=false rather
than presenting configuration as proof. No additional Google credential is
known to be missing: an actual successful STT provider result is still required.

`npm run check` passes, including all11 voice runtime contracts. Real generated
audio is not equivalent to a successful recording→transcript→reasoning→playback
workflow. See NARI_DEPLOYMENT.md for deployment/recovery.

---
## Historical implementation notes (superseded where noted above)

# Nari voice — Stage 2 implementation and release notes

## Scope and honest status

Voice-note transcription and message-bound speech playback are implemented in tracked source and tested with HTTP doubles. They have **not** been tested against real Gemini credentials or a physical Android microphone/speaker. This is **not a completed Stage 2 acceptance**. Live two-way voice is **not implemented** and is reported unavailable; no live-call control is shown.

Official documentation inspected during implementation:
- https://ai.google.dev/gemini-api/docs/audio
- https://ai.google.dev/gemini-api/docs/speech-generation
- https://ai.google.dev/api/interactions

These document the Interactions endpoint, inline audio, `model_output` steps and text/audio output. Documentation support does not prove access through this account.

## Architecture and contracts

1. Existing Hallyu login token authenticates the Edge Function via PostgREST `current_profile_id`; an active profile is required. No second login.
2. Web MediaRecorder / native expo-av captures a voice note. Recording is limited to approximately 59 seconds in the DM UI (60 second library safety cancellation). Native temporary files are deleted after reading or cancellation.
3. `operator-voice` `transcribe` validates a bounded request (5.7 MB JSON, 4 MiB decoded audio), MIME allowlist and base64. Gemini receives audio and transcription instructions only; it cannot execute tools.
4. Transcript appears in the existing editable DM composer. The user taps Send, invoking the same `sendDirectMessage` path as typing. Transcription alone never creates a message or invokes reasoning. This deliberately replaces immediate voice-turn dispatch, preventing accidental double submissions.
5. Normal worker/provider reasoning returns the ordinary Nari DM.
6. User enables spoken-response controls (device-local preference scoped by profile). Play calls `synthesize` with `message_id` and `chunk_index`, never arbitrary client text.
7. Backend requires that the message is addressed to the caller and sent by an active operator staff identity. It reads the exact body server-side. Long text is split without dropping characters into <=1800-character chunks; messages over 20,000 characters are explicitly rejected, not truncated.
8. Playback generates one WAV chunk at a time, plays sequentially, and offers pause/resume/stop/retry. Stop/unmount aborts requests, invalidates late responses and unloads sound. No generated audio is persistently cached.

### Endpoint shapes

`POST /functions/v1/operator-voice`, Bearer current Hallyu session:

- `{action: 'status'}` -> configuration flags, `stt_ready:false`, `tts_ready:false`, `live_ready:false`. This does not spend credits or pretend that configured means verified.
- `{action:'transcribe',audio_base64,mime_type}` -> `{ok:true,transcript,voice_model}`.
- `{action:'synthesize',message_id,chunk_index:0}` -> `{ok:true,tts_synthesized:true,audio_base64,audio_mime_type:'audio/wav',message_id,chunk_index,chunk_count,voice_model}`.
- Failures return non-2xx `{error:code}`. Provider bodies/credentials are not exposed.

Only `https://generativelanguage.googleapis.com/v1beta/interactions` is used. No Vertex/Studio retry, no model fallback, no reasoning-provider credits used by voice. `store:false` requests non-persistent Gemini interactions; Hallyu's ledger stores no audio or transcript. Provider's own processing policies still apply.

## Limits and audit

Migration 95 adds `operator_voice_request` and service-only `operator_voice_reserve`. Global transaction advisory lock serializes reservations, enforcing 6 requests/user/minute, 100/user/rolling 24 hours and 1000 globally/rolling 24 hours. Failures, cancelled and abandoned reservations count; no automatic retries. Each speech chunk consumes one reservation. These are fixed safety caps in this migration, not an implemented admin-configurable budget UI.

Ledger records actor, action, exact model, outcome, provider usage JSON (including modality data if returned), and sanitized error code. No prices are invented. RLS permits admin reads only; clients cannot insert/update usage or execute reservations. Reservations are fail-closed if the ledger is unavailable. A disconnected request may still be billed by the provider; stop is not a billing refund.

## Deployment evidence and remaining release gates

- Supabase existing project: `ltyymanoidagwsapgiql`.
- Connector `create_migration`, name `operator_voice_limits`: succeeded. Tool returned a null migration version; do not invent a version.
- Post-deployment catalog query confirmed: RLS enabled; anonymous SELECT false; authenticated INSERT false; authenticated reserve EXECUTE false; service-role reserve EXECUTE true.
- Existing `operator-voice` remains version 2. New function **not deployed**. New client **not deployed**.
- Production secret-name inspection confirmed `GEMINI_VOICE_API_KEY` exists. `GEMINI_VOICE_STT_MODEL` and `GEMINI_VOICE_TTS_MODEL` are absent. Values were not retrieved.

Required account-owner action: choose and explicitly approve account-accessible Gemini STT/TTS models, then set those two environment variables through Supabase secrets. Current official docs show audio-capable Gemini models and dedicated TTS models, but none has been verified through this account. Do not copy reasoning-model IDs from Coarena into voice settings. If the existing key belongs to Vertex Express rather than Gemini Developer API, provision an authorized Developer API credential or implement an explicitly selected Vertex transport; there is intentionally no implicit endpoint switch.

Release procedure:
1. Verify schema migration 95 against the existing project; it has already been applied in this session, so reconcile the connector migration history before a CLI bulk push. Do not reapply CREATE TABLE blindly.
2. Configure the approved voice model env vars; preserve existing provider secrets.
3. Run `npm run test:voice-runtime`, `npm run typecheck`, `npx deno check supabase/functions/operator-voice/index.ts`, `npm run test:sql`, `npm run build`.
4. Coordinate client and function release. New synthesis requires message IDs, while old deployed clients may send free text/`voice_turn`. This is a breaking endpoint-contract migration and is intentionally not silently pushed over the existing endpoint.
5. Deploy tracked function with `supabase functions deploy operator-voice --project-ref ltyymanoidagwsapgiql` (or upload generated `_bundles/operator-voice.js` through the connector). Session JWTs are verified in-handler; config `verify_jwt=false` supports current custom OAuth sessions.
6. Release web/Android client together, or add a versioned compatibility route before deployment. Real STT, TTS, account access and user-role tests are required before declaring ready.
7. Exercise microphone denied, cancel during recording/transcription/loading/playback, long responses, cross-user message IDs, quota exhaustion and low-end Android resource behavior.

Rollback: keep the new additive ledger/table (no user data deletion); roll back the function and matching client as a pair to a reviewed previous artifact. Do not reconstruct the old function from the connector's truncated bundle output.

## Tests in this pass

- `node --test scripts/test-voice-runtime.mjs scripts/test-provider-runtime.mjs`: PASS, 14 nested cases / 16 including suite parents. Tests execute tracked transport and bundled handler with backend/provider doubles. Covers malformed audio, lossless chunking, fixed endpoint/no fallback, incomplete responses, missing auth, transcription separation, cross-user TTS denial, spend denial and message binding.
- First chunk-boundary test caught an off-by-one; repaired, full rerun passed.
- `npm run typecheck`: PASS.
- `npx --yes deno check supabase/functions/operator-voice/index.ts`: PASS.
- `npm run test:sql`: PASS, SQL parser/static checks, not local PostgreSQL execution.
- `npm run build`: PASS after local no-save AJV 8 installation repaired an existing npm dependency-tree resolution issue. No dependency lockfile change was made. Reproducible dependency resolution remains a separate repository concern.
- `git diff --check`: PASS.

Not tested: real Gemini STT/TTS, WAV playback on Android/web browser, microphone lifecycle on physical devices, concurrent PostgreSQL budget execution, live voice. Backend access is available; these outstanding verification and live-voice implementation tasks are not falsely classified as missing Supabase permissions.

## Files for Stage 2

- `supabase/functions/operator-voice/index.ts`
- `supabase/functions/_shared/operator/voice.ts`
- `supabase/functions/_bundles/operator-voice.js`
- `supabase/migrations/20261123000000_95_operator_voice_limits.sql`
- `supabase/config.toml`
- `lib/api/voice.ts`
- `components/operator/SpokenMessage.tsx`
- `app/messages/[handle].tsx`
- `scripts/build-operator-bundles.mjs`
- `scripts/test-voice-runtime.mjs`
- `package.json`
- This document and the project evidence index.

The worker bundle was also regenerated to reflect Stage 1 provider/worker source changes; it was not deployed.


## Coordinated contract deployment update (2026-11-17)

The message-bound voice/transcription source from `ad4bb1e` and matching client are now deployed
through the existing Supabase/Vercel projects. Status includes `contract_version: 2`; matching
client controls require that version. This supersedes earlier statements that the source/client
were not deployed. It does **not** establish actual Gemini model generation, physical-device
recording/playback, or live full-duplex voice. See `NARI_INTELLIGENCE.md` for deployed source hashes,
transport caveats and actual reasoning-provider billing evidence. No voice model was silently
substituted and no text-provider fallback was added.
