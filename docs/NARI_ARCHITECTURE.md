# Nari integrated architecture

## Existing application, existing identity

Nari uses Hallyu's existing Expo Router application, Supabase project
`ltyymanoidagwsapgiql`, profile records and session. There is no separate Nari
login. Server authorization resolves `current_profile_id()` and active database
roles, not client-provided role claims. Existing administrators are preserved.
The official staff profile is `hallyu.ai`, displayed as **Nari**.

## Capability → entry point

| Capability | Application entry point | Server boundary |
|---|---|---|
| Text/history | Messages → Nari (`/messages/hallyu.ai`) | DM RPCs, worker delivery |
| Voice note | Microphone in Nari DM | `operator-voice`, dedicated Google key |
| Spoken message | Message-bound playback control | `operator-voice`, ownership check |
| Personal memory | Settings → Nari memory | actor-scoped RPCs/RLS |
| Provider/model | Authorized Nari model control | `operator-admin`, explicit persisted route |
| Tasks/approvals/audit/knowledge | Settings → AI Operator | authorized admin endpoint and tool gateway |
| Campaign planning | Settings → Campaign planner; AI Operator → Campaigns → independent planner | campaign RPCs, independent of reasoning availability |
| Push registration | Settings → Notifications | device registration and push-dispatch |

## Turn flow

The client persists a real direct message. The queued worker leases the turn,
loads permitted context, uses the explicitly configured reasoning provider,
validates bounded tool requests and persists its answer as an ordinary staff DM.
Completion requires successful delivery; approval-required work persists a
visible explanatory notice. Realtime updates are backed by foreground refresh,
active/idle polling and explicit history errors with Retry. Legacy two-argument
history and three-argument pagination remain compatible (migration110).

Coarena `gpt-6-luna` is the current documented default. APINEX is separately
selectable and has returned a real billing error. Neither voice nor reasoning
silently falls back to another provider/model.

## Voice is a separate trust boundary

Recording → bounded validated audio → dedicated Google transcription → editable
composer → explicit Send → normal reasoning. Playback reads an authorized Nari
message by ID server-side; clients cannot synthesize arbitrary text. PCM output
is wrapped in a valid mono 24 kHz WAV. Status reports configuration, not a
billable readiness claim. See NARI_VOICE.md for actual provider evidence and gaps.

## Data and execution safety

Personal memory is actor-scoped; organizational knowledge is separately governed.
Tool arguments, roles and required approvals are checked server-side. Approval
consumption and protected mutation are atomic. Public/destructive operations are
not authorized by model output alone. Worker leases, deduplication keys and
bounded delegation protect retries. Audit records retain actors/results without
provider credentials. See NARI_TOOL_INVENTORY.md for per-tool coverage rather
than assuming every registered tool has a full gateway production test.

No live/full-duplex voice is implemented. No physical Android performance claim
is made from browser or static tests.
