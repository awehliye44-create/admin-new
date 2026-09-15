# Atomic fare-increase claim — local review (DO NOT APPLY / DO NOT DEPLOY)

**Date:** 2026-09-15  
**Frozen trip:** MK-260915-002 — unchanged (no deploy, migrate, refund, capture, or live payment test).

## Release verdict: **FAIL — not ready for production**

Local work is complete and proven against non-production Postgres + Deno unit tests.  
Production release is blocked until the draft migration is reviewed, applied with matching Edge deploy, and a controlled live re-proof is authorised.

## Migration scope (unapplied)

| Artifact | Path |
|---|---|
| Forward (draft) | `supabase/migrations/_draft_review_only/20260915120000_atomic_fare_increase_modification_claim.sql` |
| Rollback | `supabase/migrations/rollback/rollback_20260915120000_atomic_fare_increase_modification_claim.sql` |

Adds:

1. `payment_session_authorisations.trip_change_request_id` + unique partial index for `ADDITIONAL_AUTHORISATION_CONFIRMED` per modification  
2. `trip_modification_apply_events` (unique on `trip_change_request_id`)  
3. `trip_has_unresolved_fare_increase_modification(uuid)`  
4. `claim_and_apply_fare_increase_modification(...)` — `FOR UPDATE` + conditional claim + `advance_trip_change_after_payment` in one transaction  

## Rollback plan

1. Stop / roll back Edge functions that call the new RPC (`confirm-trip-modification-payment`, `stop-workflow`, `revolutCompletionCapture` callers).  
2. Apply `rollback/rollback_20260915120000_atomic_fare_increase_modification_claim.sql` (drops functions, events table, indexes, column).  
3. Confirm no in-flight `payment_confirmed` fare-increase rows remain unresolved before rollback.

## Edge / UI wiring (local only)

- `confirm-trip-modification-payment` → atomic RPC after provider gate; HTTP 202 copy exact  
- `guest-trip-action` → same 202 copy  
- `stop-workflow` `complete_trip` + `revolutCompletionCapture` → block on unresolved fare-increase (fare untouched)  
- WhatsApp tracker → 202 message + local `paymentReconciling` disables re-confirm  

## Test evidence

| Check | Result |
|---|---|
| BEGIN/ROLLBACK parse harness | `ATOMIC_CLAIM_PARSE_ROLLBACK_PASS` |
| Serial idempotency sim | first=`MODIFICATION_APPLIED`, second=`ALREADY_APPLIED`, delta=311, events=1, auth=1, wallet/capture=0 |
| Two parallel psql confirms | `PARALLEL_CONCURRENCY_PASS` (1 apply / 1 already-applied / fare 811 / events 1 / auth 1 / wallet+capture unchanged) |
| Deno mapping + gate tests | 19 passed / 0 failed |

## Stop

Awaiting human review before any apply, deploy, commit, push, or live payment re-test.
