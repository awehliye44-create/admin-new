# Targeted release manifest — Scheduled marketplace / payment parity (P0)

**Date:** 2026-11-12  
**Status:** READY FOR OWNER APPROVAL — **no production deploy until approved**  
**Phase 5 flags:** remain **false**

## Root cause corrections

1. **Marketplace ≠ response window** — `shouldConvertScheduledToUrgent` no longer anchors on `scheduled_broadcast_at`. Response window uses `broadcast_started_at` and/or first `ride_offer` only. Auto-publish / Make Available still sets `scheduled_broadcast_at` for Scheduled Jobs visibility without starting NRO countdown.
2. **Webhook / CTAP failure parity** — definitive finalize failures (e.g. `SCHEDULED_ADVANCE_WINDOW`) use guarded `releaseHoldForPaymentSession` after tripless re-check; temporary errors stay on bounded recovery.
3. **Advance window payment-attempt clock** — validate at preauth; persist `advance_window_validated_at` / `advance_window_validated_scheduled_at`; finalisation / SQL trigger re-check within a **10-minute** completion bound against the validated clock when pickup is unchanged and still feasible.
4. **Customer handoff + financial outcome SSOT** — `bookingFailedHoldReleased` only after confirmed release/reverse; advance codes do not imply release; CTAP `extraBody` cannot overwrite `BOOKING_FAILED_PREAUTH_REVERSED` / `PAYMENT_ORPHANED`.

## Safety condition 1 (updated)

| Check | Result |
|---|---|
| Boot abandon result respected | PASS |
| Released copy only on confirmed reverse / abandon true | PASS |
| Advance codes alone do not claim release | PASS |
| CTAP financial codes protected from `extraBody` | PASS |

Safety conditions **2–5** remain valid from the pre-deploy gate (concurrency reuse, 10m binding, active-trip window, Phase 5 false).

## Approved commits (pending Owner deploy approval)

| Repo | Branch | SHA |
|---|---|---|
| Backend (`admin-new`) | `fix/scheduled-marketplace-dispatch-timing-parity` | *(see Final report after commit)* |
| Customer (`onecab-customer-native`) | `fix/scheduled-booking-handoff-advance` | *(see Final report after commit)* |

Prior accepted tip (superseded for handoff/CTAP code-merge): backend `cfad376a…`, Customer `8a131fb…`.

## Required migration

| Migration | Purpose |
|---|---|
| `20270218140000_scheduled_advance_payment_attempt_clock.sql` | Session validated-at columns + trip insert trigger uses payment-attempt clock |

## Required Edge deployments (after approval)

| Function | Why |
|---|---|
| `scheduled-dispatch` | Activation stamps `broadcast_started_at`; convert select includes it |
| `schedule-dispatch` | Conversion sweep passes `broadcast_started_at` (coordinated pair) |
| `revolut-webhook` | Definitive finalize → guarded release |
| `create-trip-after-payment` | Advance clock + financial outcome code protection |
| `create-preauth-payment-intent` | Via shared `revolutPreauth` advance validate + stamp |

Shared modules (bundled with above): `scheduledDispatchConfig`, `scheduledAdminReleaseSSOT`, `scheduledAdvanceWindowSSOT`, `bookingFinalizeFailureSSOT`, `paymentSessionSSOT`, `revolutPreauth`.

## Customer OTA

**Required** — production channel for iOS + Android runtimes (handoff financial outcomes).  
**Not** preview unless Owner confirms necessary.

## Driver OTA

**Not required.**

## Rollback plan

1. Redeploy previous Edge versions for the five functions above.  
2. Do **not** drop `advance_window_validated_*` columns (nullable; harmless). Optionally restore prior `trips_enforce_scheduled_advance_window` body if needed.  
3. Customer: republish prior OTA.  
4. Do **not** roll back capture-deadline / payment-first / marketplace Realtime protections.

## Isolated verification

| Scenario | Result |
|---|---|
| A marketplace publish +4m | PASS |
| B response after NRO start | PASS |
| C urgent at T−9 / convert_at | PASS |
| D Apple Pay latency past 20m wall | PASS — validated clock |
| E stale / mismatched | PASS — fail closed |
| F definitive vs temporary / adopt | PASS |
| G instant path (locks + scheduled-only gating) | Partial PASS (accepted residual) |
| Safety-1 abandon true/false/throw | PASS (unit) |
| Safety-1 advance before/after auth | PASS (unit) |
| Safety-1 CTAP code overwrite guard | PASS (unit + source lock) |
| Migration `20270218140000` isolated | PASS (prior disposable Postgres) |
| CTAP/webhook concurrency reuse | PASS (`/tmp/conc_out4.txt` + locks) |

## Follow-ups (out of scope)

- Scenario G method-specific instant E2E harness  
- Instant final-wave exhaustion (6m is max, not guaranteed min)  
- Customer Requested/Confirmed wording  
- **67 historical AUTHORISED tripless sessions** — separate financial reconciliation; **do not** release in this deploy  

## Production closure (read-only + guarded release)

- MK-006 / MK-007: **not resurrected**  
- Active scheduled trips (7d non-terminal): **none** at last pre-deploy check  
- Additional orphan `705ac32c…` / order `6af6234e…` (£5.66, TOO_SOON, tripless): **released** at ~20:41Z (same class as prior orphan)
