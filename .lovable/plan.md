# Payment Authorisation Lifecycle SSOT

Goal: the original AUTHORISED hold on the parent Revolut order is protected end-to-end. Recovery = "additional customer action required", not cancellation. Nothing in the platform may auto-cancel/release a valid AUTHORISED hold except: successful capture, successful recovery capture, admin abandon, or natural provider expiry.

## What's already true (keep)
- Webhook now writes `payment_status = 'recovery_required'` (not `canceled`) when the parent session is still `AUTHORISED` and `additional_auth_status = PAYMENT_RECOVERY_REQUIRED` (patched last turn).
- `create-payment-recovery` creates a NEW Revolut order and never touches the parent session's `provider_order_id` or state.

## What's still wrong / risky
1. `admin-cancel-trip-payment` and `revolut-cancel-order` will happily cancel any AUTHORISED order — no guard against cancelling a hold that has an open recovery in flight.
2. The completion path that hit "Re-hold not authorised: PENDING" wrote `capture_failed` on `trips` and did not set `payment_sessions.status = 'PAYMENT_RECOVERY_REQUIRED'` — so admin UI has no canonical "recovery in progress" pill.
3. No DB trigger prevents rogue writes that flip a still-AUTHORISED parent to `cancelled`/`released` while a recovery is open.
4. Admin UI for a recovery-required trip doesn't yet show: original hold state, hold expiry, shortfall, recovery order status, release trigger.
5. Customer app copy still shows "cancelled"/"capture failed" for `recovery_required`.

## Changes

### 1. Backend — protect the hold

**`supabase/functions/_shared/paymentHoldGuard.ts` (new)**
Small helper `assertHoldReleaseAllowed(supabase, tripId, { reason })` returning `{ allowed, reason_code }`. Blocks release if:
- parent session `provider_state = 'AUTHORISED'` AND
- any open recovery session exists (`purpose=PAYMENT_RECOVERY`, status in RECOVERY_CHECKOUT_CREATED / CUSTOMER_ACTION_REQUIRED) OR `additional_auth_status = PAYMENT_RECOVERY_REQUIRED` AND
- caller is not `admin_abandon_recovery` or `provider_expiry`.

**`admin-cancel-trip-payment`, `revolut-cancel-order`**
Call `assertHoldReleaseAllowed` first. Return 409 `HOLD_PROTECTED_BY_RECOVERY` with the recovery session id when blocked. Add explicit `reason: 'admin_abandon_recovery'` path that requires `abandon_recovery: true` in the request body — this is the only way to force-release a hold while recovery is pending.

**`revolut-webhook`**
On parent-order `CANCELLED`/`FAILED` event, still update `payment_sessions.provider_state`, but do NOT write `trips.payment_status` if an open recovery exists. Add branch: when recovery `RECOVERY_COMPLETED` arrives, THEN call `cancelRevolutOrder` on the parent to release the old hold, set parent session `status='released'`, write `trips.payment_status='captured'`, and log `HOLD_RELEASED_AFTER_RECOVERY`.

### 2. Backend — completion path canonicalisation

**Wherever `recordCardCaptureFailure` is invoked with a PENDING/failed re-hold** (currently reached via driver-app audit event `CARD_CAPTURE_FAILED` — trace and patch the true caller if it lives in stop-workflow / mobile RPC):
- Do not set `trips.payment_status='capture_failed'` when the parent hold is still AUTHORISED.
- Set `trips.payment_status='recovery_required'`.
- Upsert on the parent `payment_sessions` row: `status='PAYMENT_RECOVERY_REQUIRED'`, `metadata.additional_auth_status='PAYMENT_RECOVERY_REQUIRED'`, `metadata.shortfall_pence=<final-authorised>`.
- Log audit `PAYMENT_RECOVERY_REQUIRED` (never `CARD_CAPTURE_FAILED` in this branch).

### 3. Database guard

New migration:
- Trigger `trg_protect_authorised_hold` on `payment_sessions BEFORE UPDATE`: reject transitions of a `RIDE_BOOKING` session from `provider_state='AUTHORISED'` to `status IN ('cancelled','released','failed')` when an open recovery exists — unless `metadata.release_trigger` is one of `capture_success`, `recovery_captured`, `admin_abandon_recovery`, `provider_expired`.
- Trigger on `trips BEFORE UPDATE`: reject flipping `payment_status` from `recovery_required` to `canceled`/`cancelled` unless the same `metadata.release_trigger` set is present.

### 4. Admin UI

**`src/pages/PaymentSessions.tsx` (recovery row expander) and trip detail**
Show a "Payment authorisation lifecycle" block:
```text
Original hold      AUTHORISED    £10.89    expires 2026-07-23 21:32 UTC
Shortfall          £2.99
Recovery order     rev_xxx       CUSTOMER_ACTION_REQUIRED
Release trigger    (none — protected)
```
Buttons:
- "Request customer payment" (existing, calls `create-payment-recovery`).
- "Abandon recovery & release hold" (new) — confirmation dialog, calls `admin-cancel-trip-payment` with `abandon_recovery: true` and `reason` required.
Remove any "Capture failed" / "Cancelled" pills for `recovery_required` trips; use `Recovery required` (orange) — already added to `tripFinancialAuditStatus.ts`.

### 5. Customer app copy
Not this repo. Emit a checklist in `docs/PAYMENT_RECOVERY_CUSTOMER_APP.md` describing the strings the mobile team must map for `payment_status='recovery_required'`: "Payment authorisation needed to complete your last ride" + deep link to the recovery checkout URL exposed on the recovery `payment_sessions` row.

### 6. Audit endpoint

New `supabase/functions/admin-payment-lifecycle-audit/index.ts` — GET `?trip_id=`. Returns:
```json
{
  "original_hold": { "session_id", "provider_order_id", "provider_state", "authorised_amount_pence", "expires_at" },
  "shortfall_pence": 299,
  "recovery": { "session_id", "provider_order_id", "status", "checkout_url", "captured_amount_pence" },
  "release_trigger": null,
  "capture_trigger": null,
  "invariant_check": { "auto_cancelled_authorised_holds": [] }
}
```
Invariant check runs a query over recent trips: any `trips.payment_status IN ('canceled','cancelled')` whose parent session still has `provider_state='AUTHORISED'` and no `release_trigger` — must return empty. Wired into the Ops detection cron.

### 7. Backfill
One-off SQL migration: for trips where `payment_status='canceled'` AND parent session `provider_state='AUTHORISED'` AND no `release_trigger` — set `payment_status='recovery_required'` and stamp `payment_sessions.status='PAYMENT_RECOVERY_REQUIRED'`. Same repair MK-260716-016 got manually.

## Non-goals
- No changes to fare engine, dispatch, driver settlement, or ledger. Driver already paid net via wallet ledger; recovery only closes the customer-side capture.
- No changes to `finalize_paid_booking_session` — booking gate is a separate SSOT.

## Files touched
- New: `supabase/functions/_shared/paymentHoldGuard.ts`, `supabase/functions/admin-payment-lifecycle-audit/index.ts`, `docs/PAYMENT_RECOVERY_CUSTOMER_APP.md`, one migration.
- Edit: `admin-cancel-trip-payment`, `revolut-cancel-order`, `revolut-webhook`, `_shared/onecabFinanceLedger.ts` (recordCardCaptureFailure branch), `src/pages/PaymentSessions.tsx`, trip detail component that renders the lifecycle block.

## Proof
- Vitest: extend `paymentSessionAdditionalAuthSSOT.test.ts` with 4 cases — capture within hold, additional-auth AUTHORISED, additional-auth PENDING (must yield recovery_required not canceled), recovery captured (must trigger parent release).
- SQL invariant check returns empty in staging + prod backfill run.

Ship in one turn after approval; no schema-breaking changes.
