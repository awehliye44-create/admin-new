# Targeted release manifest — Scheduled marketplace / payment parity (P0)

**Date:** 2026-11-12  
**Status:** READY FOR OWNER APPROVAL — **no production deploy until approved**  
**Phase 5 flags:** remain **false**

## Root cause corrections

1. **Marketplace ≠ response window** — `shouldConvertScheduledToUrgent` no longer anchors on `scheduled_broadcast_at`. Response window uses `broadcast_started_at` and/or first `ride_offer` only. Auto-publish / Make Available still sets `scheduled_broadcast_at` for Scheduled Jobs visibility without starting NRO countdown.
2. **Webhook / CTAP failure parity** — definitive finalize failures (e.g. `SCHEDULED_ADVANCE_WINDOW`) use guarded `releaseHoldForPaymentSession` after tripless re-check; temporary errors stay on bounded recovery.
3. **Advance window payment-attempt clock** — validate at preauth; persist `advance_window_validated_at` / `advance_window_validated_scheduled_at`; finalisation / SQL trigger re-check within a **10-minute** completion bound against the validated clock when pickup is unchanged and still feasible.
4. **Customer handoff** — definitive released-hold copy; advance-window codes treated as dead hold → recoverable Book state (no indefinite spinner / no success without trip id).

## Required migration

| Migration | Purpose |
|---|---|
| `20270218140000_scheduled_advance_payment_attempt_clock.sql` | Session validated-at columns + trip insert trigger uses payment-attempt clock |

## Required Edge deployments (after approval)

| Function | Why |
|---|---|
| `scheduled-dispatch` | Activation stamps `broadcast_started_at`; convert select includes it |
| `schedule-dispatch` (if deployed separately) | Conversion sweep passes `broadcast_started_at` |
| `revolut-webhook` | Definitive finalize → guarded release |
| `create-trip-after-payment` | Finalisation advance clock + released copy |
| `create-preauth-payment-intent` | Via shared `revolutPreauth` advance validate + stamp |

Shared modules (bundled with above): `scheduledDispatchConfig`, `scheduledAdminReleaseSSOT`, `scheduledAdvanceWindowSSOT`, `bookingFinalizeFailureSSOT`, `paymentSessionSSOT`, `revolutPreauth`.

## Customer OTA

**Required** — handoff copy + dead-hold codes for advance-window definitive failures.

## Driver OTA

**Not required** for this correction (marketplace listing predicates unchanged; convert timing is backend).

## Rollback plan

1. Redeploy previous Edge versions for the five functions above.  
2. Do **not** drop `advance_window_validated_*` columns (nullable; harmless). Optionally restore prior `trips_enforce_scheduled_advance_window` body if needed.  
3. Customer: republish prior OTA.  
4. Do **not** roll back capture-deadline / payment-first / marketplace Realtime protections.

## Isolated verification (executed)

| Scenario | Result |
|---|---|
| A marketplace publish +4m | PASS — no convert |
| B response after NRO start | PASS |
| C urgent at T−9 / convert_at | PASS |
| D Apple Pay latency past 20m wall | PASS — validated clock |
| E stale / mismatched | PASS — fail closed |
| F definitive vs temporary / adopt | PASS |
| G instant path untouched (source + existing locks) | PASS (no intentional instant changes) |

Deno: 22 tests passed. Customer jest locks: 26 passed.

## Production closure (read-only + guarded release)

- MK-006 / MK-007: **not resurrected**  
- Active scheduled trips (7d non-terminal): **none**  
- Additional orphan `705ac32c…` / order `6af6234e…` (£5.66, TOO_SOON, tripless): **released** at ~20:41Z (same class as prior orphan)
