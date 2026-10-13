# Capture composition SSOT — release preparation (DO NOT APPLY YET)

## Status

DRAFT_FIX_ONLY — STOPPED_FOR_CAPTURE_SSOT_RELEASE_APPROVAL

No migration, deploy, merge, live booking, or provider mutation in this package.

## Root-cause classification (proven)

**C. CAPTURE_USES_CUSTOMER_PAYABLE_ONLY**

First broken assignment (incident path, pre-SSOT):

`finalFarePence = computeCaptureAmount(...).capture_amount_pence`
(= `final_fare_pence + tips_pence`, no receivable)

Then `release_remainder_pence = authorisedHold − finalFare` treated the 36p
RESERVED receivable as unused hold. Metadata retained `customer_receivables_pence`
(not lost). Buffer column was not rewritten to 36 — collapse was payable-only
capture + remainder release semantics (B co-fact).

## Migration (pending approval)

- Forward: `supabase/migrations/20261130120000_capture_composition_components.sql`
- Rollback: `supabase/migrations/rollback/rollback_20261130120000_capture_composition_components.sql`

Adds on `payment_sessions`:

- trip_fare_component_pence
- tip_component_pence
- receivable_component_pence
- provider_capture_target_pence
- capture_composition_version
- capture_idempotency_key (+ unique partial index)

## Edge import / deployment closure (after approval)

Deploy only after migration applied. Shared modules are imported by these Edge entrypoints:

1. `finalize-trip-and-capture` → `revolutCompletionCapture` (+ loadPlan)
2. `capture-expired-tip-windows` → finalize invoke + planner import
3. `admin-capture-trip-payment` → `adminCaptureTripPaymentSSOT` (+ loadPlan)
4. `admin-remediate-trip-payment` → finalize path
5. `sweep-revolut-stale-holds` → finalize invoke + planner import
6. Any tip Skip / Submit tip=0 / tip>0 path → finalize → `revolutCompletionCapture`

Settlement gate: `paymentSessionSSOT.markPaymentSessionCaptured` (also via `persistConfirmedProviderCapture`).

Suggested deploy set (order: migrate first, then Edge):

```
finalize-trip-and-capture
capture-expired-tip-windows
admin-capture-trip-payment
admin-remediate-trip-payment
sweep-revolut-stale-holds
```

(Plus any other function that bundles `_shared` and is redeployed from financial-main.)

## Package hashes (SHA-256)

```
85adad7bb75d00f3997b1027c900696d82a4cb579f01fffd59e9cf060870689e  captureCompositionSSOT.ts
c595cbff88cfb2fdea0e4aabe3a57c8e64337c52887babf137c79c564fe78c50  captureCompositionLoadPlan.ts
a405614b5ea752ce0c6291dc97826294eefa1c0b4bd011458a756cbc354c49f4  20261130120000_capture_composition_components.sql
f17df515543435ebdc5dffff25ac8e548d3bb7884b843eb62885eb5337ab799f  revolutCompletionCapture.ts
6c488db6f146ba99e0a6cfa4a3905b49253795a1f2ff7f78f32a79abef655a58  paymentSessionSSOT.ts
2ae9030def166625e7ebb5fe99ed2a6eca799fbd27ffb34f49876d53e7b39bf0  adminCaptureTripPaymentSSOT.ts
de2541393d07b1b68bdaf05c7657f04181cdd06f50f2760e7ad9fa15c3d1bcc2  package-lock.json
763ec17d6cb27efdeb9469fc9a5827d3e2d1a3cd7118f7c5159ad3b21af48e6e  deno.lock
```

## Gate

`CUSTOMER_RECEIVABLE_FOLD_ENABLED=false` (unchanged).

## Zero-money verification plan (post-release, not now)

1. Dry-run planner unit locks (already green): `deno test supabase/tests/_shared/captureCompositionSSOTLock.test.ts`
2. Staging payment session with RESERVED 36 + auth 536: persist composition → assert target 536, receivable_component 36, no Revolut POST yet
3. Capture POST with composition → GET COMPLETED 536 → settle 36 once; OPEN=0 RESERVED=0
4. Incident remediations: fare-only persisted component 0 + GET 500 → settle 0 + release to OPEN (no TEN/commission change)
5. Tip decline path: zero captureRevolutOrder calls
6. Confirm no second order/payment; wallet TRIP_EARNING_NET = fare TEN only
7. Re-run receivable reconcile → released=0

## Out of scope (separate PR)

Recurring 3DS challenge / hosted-checkout auto-close defect.
