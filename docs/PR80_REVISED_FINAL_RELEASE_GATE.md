# PR #80 — Revised final release gate (four blockers fixed)

**Package tip:** `0f5a856f38fc5541dd9c3856559329598be30bd5`  
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

## Live ezbr (full)
- `finalize-trip-and-capture` v535: `897b6306d718c70569f0e76de773abacdb557ad834330bb35f6c4d95c3712971`
- `admin-capture-trip-payment` v308: `533d7fa3a2a2cdc58667612ba8f076dda784a7346e9ba29f3e14ee1241317412`
- `admin-remediate-trip-payment` v121: `2cb920ad2fb919e980c75f6431c5e8a15daeac42493a57351303dc58e82beb7a`
- `capture-expired-tip-windows` v167: `fdd70e6e405306e5de882e3b8eae801b0b1699467c4a977a350e0bd8dc6538fe`
- `submit-customer-trip-tip` v80: `bc9f6f4e1904e657fb031b9f96c5f36577c1afba2a6a73311cfdefafa113dea5`
- `sweep-revolut-stale-holds` v176: `a69bba897a18290aee242b0595adcddef38a567e3776e797677f2dc8f0b80e25`
- `stop-workflow` v651: `1f6b1d5f8a285991e4b105609d7436c8b6a66f7217b29e9d7ae6bed7fd54e543`
- `revolut-webhook` v297: `b86e0d4017f48e4d1114e36eb11a5ddc0f79be36620ae13d683ecdaf3d4b01da`
- `admin-hold-action` v136: `3e72c4678e916ec7149c0fcf1e61ff3483ae8c71f0242b096f132f9296786067`
- `capture-trip-payment` v568: `fbdd3c0073e7be6861bc124c27fef96f5465b9f229e2f9e1b6778ecb61d05ac6`

## Tip package tree (full)
- `finalize-trip-and-capture` files=75: `f8ee1b3055b04932de38cc36a8a7a95d4c26d33316f29f69474fa93cb3f180df`
- `admin-capture-trip-payment` files=75: `4356ec92915ed00277bf867ef3fc4ade8634929b04c58559b09f416dae21be93`
- `admin-remediate-trip-payment` files=80: `012c33b777211128a9106edd920a8cfb905fd31e44eaf6689dde7e679abba393`
- `capture-expired-tip-windows` files=40: `bdea5bca3b9a717d23034a5ffa43759300c37677d5a492aff876594c5dbcfeaf`
- `submit-customer-trip-tip` files=11: `4c33aa9846d2e36248846c47aedb3826302c533481032c406c150eb7785800a1`
- `sweep-revolut-stale-holds` files=57: `4b84ca005e3fe965623feee71683df7b25cabde29ee51ff12179df6992ee6f4a`
- `stop-workflow` files=91: `e919a40213c5f432a1e8a4a489273b635ca979e4c629ad1bf7351f29d0912a7d`
- `revolut-webhook` files=52: `932081aa09fa15f67180404307de80e4e783a846a8db58d151f51b6535073630`
- `admin-hold-action` files=53: `2020c910d40591175007ce6eb63a97a9f20eb75b355ab434fe2648a112f6f6d6`

## Migration SHA-256
- forward: `323d723737c65692fb697b1e87505b19f53e71f16281fd989ad9cf607c6e28b2`
- rollback: `255c4579b9772dc40cc80c1dc5e4200a32480415c599a3de994a495693abb1f5`
