# PR #80 — Revised final release gate (four blockers fixed)

**Package tip:** _(set after push)_  
**Code tip candidate:** prior `1cbd29e7` + blocker fix commits  
**PR:** https://github.com/awehliye44-create/admin-new/pull/80 (draft)

## Blockers addressed

1. **Lock before plan** — `acquireLockAndResolveCaptureComposition` claims financial lock, reloads session, reloads RESERVED, then create/resume plan.
2. **Freeze/resume** — frozen plan never recomputed; second trigger adopts same target/idempotency key.
3. **Fail closed** — no fare+tip fallback when receivable evidence exists; typed errors `CAPTURE_COMPOSITION_REQUIRED` / `MISMATCH` / `RECEIVABLE_ALLOCATION_STATE_UNKNOWN`.
4. **Migration invariants** — populated CHECK (sum, ≥0), unique key, immutability trigger, `capture_composition_frozen_at`; rollback guarded when live keys exist.

## Migration hashes

- Forward `20260925120000_capture_composition_components.sql` → see commit  
- Rollback documents: safe only before any `capture_idempotency_key` used in production

## Constraints / trigger

- `payment_sessions_capture_composition_populated_chk`
- `trg_payment_sessions_capture_composition_immutable` → `CAPTURE_COMPOSITION_FROZEN_IMMUTABLE`
- RLS: existing `"Service role manages payment_sessions"` (no redundant policies)

## Race locks

`captureCompositionFreezeRaceLock.test.ts` — **16/16 PASS**  
`captureCompositionSSOTLock.test.ts` — **20/20 PASS**  
Combined composition+freeze: **36/36 PASS**

## Production Edge (live read-only, project `thazislrdkjpvvghtvzo`)

| Slug | Live ver | Live ezbr SHA-256 | Tip package files | Tip tree SHA-256 | Role |
|------|----------|-------------------|------------------:|------------------|------|
| finalize-trip-and-capture | 535 | `897b6306…3712971` | 75 | `f8ee1b30…f180df` | Direct importer (completion+acquire) |
| admin-capture-trip-payment | 308 | `533d7fa3…317412` | 75 | `4356ec92…21be93` | Direct importer |
| admin-remediate-trip-payment | 121 | `2cb920ad…2beb7a` | 80 | `012c33b7…bba393` | Bundles finalize path |
| capture-expired-tip-windows | 167 | `fdd70e6e…6538fe` | 40 | `bdea5bca…bcfeaf` | HTTP→finalize + planner import |
| submit-customer-trip-tip | 80 | `bc9f6f4e…13dea5` | 11 | `4c33aa98…5800a1` | HTTP caller only |
| sweep-revolut-stale-holds | 176 | `a69bba89…b80e25` | 57 | `4b84ca00…ee6f4a` | HTTP→finalize |
| stop-workflow | 651 | `1f6b1d5f…54e543` | 91 | `e919a402…912a7d` | HTTP→finalize |
| revolut-webhook | 297 | `b86e0d40…4b01da` | 52 | `932081aa…073630` | Persist/settle path |
| admin-hold-action | 136 | `3e72c467…786067` | 53 | `2020c910…f6f6d6` | paymentSessionSSOT |
| capture-trip-payment | 568 | `fbdd3c00…d05ac6` | — | retired stub | **Do not deploy** unless proven reachable |

Rollback version = prior live ezbr above (redeploy previous package).

## Production fingerprint (unchanged)

OPEN 30p+6p · RESERVED/SETTLED/WAIVED 0 · MK-002 captured 500 once · TEN 425 · commission 75 · no new mutation

## Gates

FOLD_GATE_OFF · NO_LIVE_BOOK · NO_PROVIDER_MUTATION · NO_MERGE · NO_MIGRATION · NO_DEPLOY  

**STOPPED_FOR_REVISED_FINAL_RELEASE_APPROVAL**
