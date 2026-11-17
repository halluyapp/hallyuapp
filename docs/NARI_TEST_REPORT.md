# Nari verification report

## 2026-11-17 — explicit provider switch and browser authentication

**Complete and tested for this change**

- Coarena / `gpt-6-luna` is the explicit default; APINEX is nondefault.
- Real deployed worker: saved preference recalled; sourced feature answers,
  unsupported-statistics refusal and injection resistance all passed in backend
  acceptance `c8a3ca17-6491-47bc-a3d8-7ae93ebd47b1` (HTTP response 712).
- Scoped memory lifecycle/isolation, knowledge permissions/version conflicts,
  constitution loading and fixture cleanup passed in that run.
- Browser acceptance step in GitHub run `44050027798` passed against production:
  real sign-in, memory persistence/correction/deletion, admin-only knowledge UI,
  revision history, temporary fixture cleanup.
- Local `npm run check`, Expo web export using `/hallyuapp`, HTML enhancement,
  and whitespace validation passed.
- Frontend deployment `dpl_CaYcKt5rdFzjGEZ1hNEtBmW67BWt`: READY / PROMOTED.

**Limitations and unresolved findings**

- Two earlier real Coarena runs failed `bad_response`; strict validation remains
  enabled. Passing the final run is not proof of continuous provider reliability.
- GitHub workflow `44050027798` failed after its passing browser and full static
  gates, during Pages export. Overall workflow is not claimed successful.
- Invalid GitHub service-role secret was not rotated: secret-management access
  was denied. This browser test instead uses narrowly scoped GitHub OIDC and
  does not require that stored key. Other consumers are not claimed repaired.
- Voice live/device acceptance and full five-stage implementation remain outside
  the verified completion of this switch. Stages 4–5 are not complete.

Detailed chronology: [NARI_INTELLIGENCE.md](NARI_INTELLIGENCE.md).
