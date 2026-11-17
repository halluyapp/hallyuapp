# Nari production deployment and recovery

## Confirmed deployment

Existing Supabase project: `ltyymanoidagwsapgiql`. Forward migrations95–110
applied; do not replay connector-applied migrations blindly with CLI bulk push.
Production function versions at final integration: operator-admin v6,
operator-worker v21 (core1.4.1), operator-voice v9. Worker/voice immutable source:
`cbef61f377268cee6a118cd9edf5c688f3c7cb41`. In-handler session authorization is
required even where platform `verify_jwt` is false for existing custom sessions.

Vercel production deployment `dpl_GRcPM4anjmH3Q1ce14C3YRiWJiFS`, source
`8752e5995bc0fe516fd032b5863cd350e27d8919`, confirmed READY and alias assigned to
https://hallyuapp.vercel.app. Later source fixes must pass the existing pipeline;
this evidence is not a claim that later commits are already deployed.

## Configuration names (never values)

- Existing Supabase URL, anon client key and private service-role credentials.
- Existing reasoning provider secrets and database model/provider policy.
- `GEMINI_VOICE_API_KEY`, `GEMINI_VOICE_STT_MODEL`,
  `GEMINI_VOICE_TTS_MODEL`, `GEMINI_VOICE_STT_TRANSPORT`.
- Current explicit STT: `gemini-3.5-transcribe`, `generateContent`; TTS:
  `gemini-2.5-flash-preview-tts`. Configured does not mean transcription passed.
- Private worker invocation token; preserve existing cron/Vault configuration.
- Native push `FCM_SERVICE_ACCOUNT_JSON` (or protected Vault
  `fcm_service_account_json`); Android build Firebase client configuration.
  See NARI_FCM_SETUP.md. VAPID is a separate web-push path.

## Repeatable release

1. Audit diff and existing migration history; preserve production data/admins.
2. Run `npm run check`, generate bundles with
   `node scripts/build-operator-bundles.mjs`, and inspect generated changes.
3. Push this session's current branch. Deploy immutable reviewed function
   artifacts using the release entrypoint generator (hash checked), not mutable
   remote source. Preserve auth settings and secrets.
4. Release through existing web/APK workflows. Vercel build success alone is not
   authenticated acceptance. Explicit deploy-web workflow input
   `run_live_browser_test=true` runs temporary real-user browser acceptance.
5. Check backend authorization, visible member/admin replies after reload,
   campaigns navigation, memory isolation, approvals and audited delivery.
6. Test voice recording/transcription/playback on a real device, and targeted
   notification receipt after actual device registration. Do not mark these
   successful from a configured flag or zero-device dispatch.
7. Remove temporary operator-acceptance function after collecting its ledgers.

## Rollback and troubleshooting

Keep additive schema/history. Roll back reviewed worker/voice and matching client
artifacts as a coordinated pair; never drop member data to fix a release.
Voice contract2 is message-bound; old arbitrary-text speech calls are incompatible.
Keep the DM overload compatibility migration for already-installed APKs.

Missing replies: inspect DM RPC errors, outbound delivery status and worker task
state, then refresh history. Do not report a task complete when delivery failed.
Campaign403: inspect the authenticated database profile/active role; never relax
server policy to match a client admin label. Custom CEO sign-in remains a
separate acceptance case from standard promoted-admin fixtures.
Voice422: no usable transcript; do not invent one. Provider404/503/timeouts are
reported explicitly, with no hidden model change. APINEX billing_error requires
account credit/access, not a different default. Push sent0/devices0 is not receipt.

## Latest production confirmation

Commit `de7368d58e6eb81a85b5c1dff519882f211ba6f4` deployed as
`dpl_5mr5AxSowWAuj5XRpXzj2joXjF3T`: READY, production alias assigned.
This includes auth-hydration DM guards and inbox verification fetch. Browser
44090174325 confirmed visible request/reply but failed exact response content;
see the test report. Temporary `operator-acceptance` has been deleted.
