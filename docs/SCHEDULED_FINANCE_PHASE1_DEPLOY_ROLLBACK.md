# Scheduled Finance Phase 1 — Deploy & Rollback (awaiting release approval)

**Status:** Code-only. Do **not** migrate, deploy Edge, publish Admin/hub/OTA, or change production settings until explicit production release approval.

Milton Keynes must remain: `enable_preauth_buffer=false`, `buffer_value=2`. Do not touch wave/commission/airport/wallet/stacking settings. Five-day (120h) advance remains the approved policy.

## Migrations (apply in order)

| Order | File | Purpose |
|------:|------|---------|
| 1 | `20270201120000_scheduled_finance_phase1_capture_deadline.sql` | `capture_deadline` columns; `assert_payment_gate`; `max_advance_days` default 5 |
| 2 | `20270201120100_scheduled_finance_phase1_gap_closure.sql` | Advance-window trigger; accept/activate gates; coverage stamp semantics |
| 3 | `20270201120200_scheduled_finance_phase1_payment_first_atomicity.sql` | `capture_deadline_observed_at`; payment-first INSERT trigger; schedule-mod coverage UPDATE trigger; `admin_assign_scheduled_driver` |

## Edge Functions (after migrations)

Deploy only after migrations succeed:

- `create-trip-after-payment` (coverage before insert; stamp `scheduled_capture_coverage_required`)
- `create-corporate-book` / `create-preauth-payment-intent` / `confirm-revolut-payment` / Revolut webhook + increment paths (persist deadline + observed_at)
- `scheduled-dispatch` (`payment_gate_blocked` sweep + gates)
- `validate-scheduled-booking`
- Related cancel/dispose paths only if already queued in the same release train

## Client surfaces (same release train)

- Corporate hub `BookRide`: card → `create-corporate-book` → Revolut confirm → `create-trip-after-payment` (no `pending_payment` trip insert)
- Admin `ScheduledRides` Assign Now → `admin_assign_scheduled_driver`
- Admin `ManualTrip`: platform card blocked in UI (existing digital gate + DB trigger)
- Customer native: 5×24h schedule window (already landed)

## Compatibility latch

`global_dispatch_settings.scheduled_capture_coverage_enforced` remains a **legacy-only** latch. New bookings stamp `payment_sessions.metadata.scheduled_capture_coverage_required=true` and are always gated. Do not flip the latch in a way that creates unpaid trips.

## Safe deploy sequence

1. Confirm MK buffer settings unchanged (`enable_preauth_buffer=false`, `buffer_value=2`).
2. Apply migration 120000 → verify `\d payment_sessions` has `capture_deadline*`.
3. Apply migration 120100 → smoke `assert_payment_gate` on a known authorised scheduled card trip.
4. Apply migration 120200 → verify triggers exist; smoke `admin_assign_scheduled_driver` on a non-prod/admin fixture.
5. Deploy Edge Functions listed above.
6. Deploy Admin + hub clients that call the new RPC / payment-first corporate path.
7. Dry-run: corporate card book creates **no** `trips` row until CTAP; Admin Assign Now fails closed on insufficient coverage; reschedule beyond capture horizon is rejected with original pickup preserved.

## Temporary unpaid-trip risk window

- **Before** migration 120200 payment-first trigger: legacy hub/Admin paths could still insert unpaid card rows if old clients are live.
- **Mitigation:** ship DB trigger **before** or **with** hub/Admin client cutover; do not deploy hub card-rewrite alone against a DB that still allows `pending_payment` card inserts.
- Existing `trg_enforce_digital_payment_gate` remains; 120200 strengthens platform-collected card INSERT.

## Rollback (RPCs + triggers, not only Edge)

Rollbacks live under `supabase/migrations/rollback/`.

### Immediate client / Edge rollback

1. Redeploy previous Edge Function revisions for CTAP / corporate-book / scheduled-dispatch / confirm / webhook.
2. Redeploy previous Admin + hub builds (Assign Now RPC call → prior write path; BookRide prior behaviour).
3. Do **not** flip MK buffer settings as a rollback lever.

### Database rollback (reverse order)

1. Run `rollback_20270201120200_scheduled_finance_phase1_payment_first_atomicity.sql`:
   - `DROP TRIGGER` payment-first + schedule-mod coverage
   - `DROP FUNCTION` those triggers + `admin_assign_scheduled_driver`
   - Keep `capture_deadline_observed_at` column (backward-compatible); drop only if required
2. Roll back 120100 objects (advance trigger / accept/activate gate patches) via the paired rollback script if present; otherwise restore prior function bodies from the pre-release schema dump.
3. Roll back 120000 only if necessary (columns are additive; prefer leaving `capture_deadline*` in place).

### Latch / legacy bookings

- Do **not** cancel valid grandfathered `>5d` bookings during rollback.
- Do **not** set `scheduled_capture_coverage_enforced` in a way that mass-cancels legacy trips; resolution of `payment_gate_blocked` stays 30-minute sweep + definitive cancel/release only when coverage is definitively insufficient.

## Post-release verification (when approved)

- Channel matrix: Customer native, guest/web, corporate hub card, Admin wallet/corporate (not platform card), webhook finalisation — all platform card paths create trips only after AUTHORISED confirmation + CTAP.
- Deadline shorten via fresher observation → immediate persist + coverage re-eval / `payment_gate_blocked` when definitive.
- Schedule mod beyond horizon → exception; original `scheduled_at` unchanged.
- Assign Now concurrent double-submit → single winner; payment failure → no assign write.
