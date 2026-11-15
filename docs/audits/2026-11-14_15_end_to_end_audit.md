# ONECAB consolidated end-to-end audit — 14–15 November 2026

Deploys (production OTA, Edge, native builds, store uploads) remain **paused** until explicitly approved.

## Bug #22 — Premature Instant Rematching After Scheduled Confirmation Cancellation

**Status:** Implemented end-to-end in backend + Customer; **not marked resolved** until Edge deploy + Customer OTA are approved and verified on a live rematch.

**Incident trip code:** `MK-261115-004`  
**Authoritative UUID:** not present in local logs/docs/repos — reconstruct via production `trips.trip_code = 'MK-261115-004'` (read-only; no historical mutations).

### Classification

**C — both layers incorrect.**

| Layer | Defect |
| --- | --- |
| Backend | `cancel_confirmed` stamped Finding-shaped rematch (`status=offered`, `scheduled_status=broadcasting`) while keeping `dispatch_mode=scheduled`. Convert clock used **check-in (~20m)** instead of shared **urgentTrigger (~9m)**. Compliance Edge/SQL twin used the same `status=offered` marketplace stamp. |
| Customer | `isScheduledActivationReached` treated `status=offered` / marketplace `broadcasting` as activated → `FINDING_DRIVER`. |

Driver marketplace reopen (Requested tab) was already correct for the incident window — no `converted_to_instant`.

### Incident timeline (reconstructed)

1. Driver accepted future scheduled booking → Confirmed tab (`confirmed_driver_id` set, `scheduled_status` reserved/committed).
2. Driver cancelled pre-JIT via `scheduled-ride-action` `cancel_confirmed`.
3. Backend: `decline_scheduled_ride` exclusion; rematch update cleared assignment; stamped `status=offered` + `scheduled_status=broadcasting` (not convert — pickup still outside check-in/urgent depending on clock).
4. Driver app: booking returned to Scheduled Jobs Requested (marketplace open).
5. Customer: Realtime / restore / lifecycle push saw `offered`+`broadcasting` → presentation `FINDING_DRIVER` (“Finding another driver”) despite future pickup and unclaimed convert deadline not reached.

### Root cause (exact)

1. **Wrong rematch stamp:** pre-urgent rematch used Instant/Finding-shaped `status=offered` instead of Make Available–shaped `status=scheduled`.
2. **Wrong convert clock (latent A):** convert keyed off `check_in_window_minutes` (~20), not `urgent_dispatch_trigger_minutes_before_pickup` / compliance urgent SSOT (~9).
3. **Customer activation over-match:** `SCHEDULED_ACTIVATED_TRIP_STATUSES` included `offered`/`broadcasting`; marketplace `scheduled_status=broadcasting` fell through to activated Finding.

### Correct behaviour (locked)

Pre-activation cancel / compliance release **before** unclaimed urgent deadline:

- Clear confirmation atomically; exclude cancelling/ineligible driver.
- Reopen Requested marketplace: `status=scheduled`, `dispatch_mode=scheduled`, `scheduled_status=broadcasting` (or `admin_held` if airport hold).
- Clear JIT / commitment / pending acknowledgement stamps.
- Customer stays on **Scheduled list**; clear stale driver details; no Finding / instant waves.
- After urgent deadline (or genuine JIT activation rescue): existing convert / rematch workflow unchanged.

### Changed files

**admin-new (backend)**

- `supabase/functions/_shared/scheduledPreActivationReleaseSSOT.ts` (+ `.test.ts`)
- `supabase/functions/scheduled-ride-action/index.ts` — `cancel_confirmed` uses urgent SSOT + marketplace/urgent patches
- `supabase/functions/_shared/scheduledJourneyComplianceGate.ts` — shared marketplace rematch patch
- `supabase/migrations/20270225120000_bug22_scheduled_preactivation_release_status.sql` (+ rollback soft note)
- Lock updates: `scheduledRematchExclusionSSOT.test.ts`, `scheduledWorkflowPhase2Lock.test.ts`, `scheduledRidesGapCloseLock.test.ts`
- CI: `.github/workflows/ci.yml`, `scripts/check-consolidated-regression-gates.sh`

**onecab-customer-native**

- `src/features/booking/lib/resolveCustomerTripPresentation.ts` — marketplace rematch → `SCHEDULED_LIST`
- `src/features/booking/lib/resolveCustomerTripPresentation.test.ts` — Bug #22 case
- `.github/workflows/ci.yml` — mandatory presentation pattern

### Execution / lock tests

- Deno: `scheduledPreActivationReleaseSSOT.test.ts` (9 cases)
- Deno: rematch exclusion + phase-2 cancel locks (updated)
- Jest: `resolveCustomerTripPresentation.test.ts` (Bug #22 + existing Finding/convert cases)

### Deployment dependencies (paused)

1. Apply migration `20270225120000_bug22_scheduled_preactivation_release_status.sql` (SQL release twin).
2. Deploy Edge: `scheduled-ride-action` + shared modules used by compliance gate.
3. Customer OTA / JS update with presentation guard.
4. Do **not** mutate historical trips.

### Rollback

1. Customer: revert presentation commit / prior OTA.
2. Edge: redeploy previous `scheduled-ride-action` / compliance gate.
3. SQL: re-apply prior `release_scheduled_assignment_for_compliance` body from `20270224120000_…` (or soft rollback comment file).

### CI / SHAs

| Repo | SHA | CI |
| --- | --- | --- |
| admin-new | `8b3c5c54c24f8b7068655806b2aa4ebb3fb04771` | https://github.com/awehliye44-create/admin-new/actions/runs/43704514827 (success) |
| onecab-customer-native | `f25365baadf95c15e5e7054436f479546076bdbb` | https://github.com/awehliye44-create/onecab-customer-native/actions/runs/43704514348 (success) |

**Not resolved for production** until migration + Edge `scheduled-ride-action` / compliance modules + Customer OTA are approved and verified end to end. Deploys remain paused.

---

## Other 14–15 November items (pointer)

- Scheduled journey future compliance (admin-new) — prior tip / CI in session history.
- Driver active-trip car marker motion — prior tip / CI in session history.
- MK-261114-006 post-Start floor — prior tip / CI in session history.
