# Atomic fare-increase modification — LOCAL_REVIEW_COMPLETE

**Status:** `LOCAL_REVIEW_COMPLETE` — **not production-ready**  
**Verdict:** FAIL for production release (intentionally). Preserve only.  
**Frozen evidence:** MK-260915-002 — **unchanged**. No financial repair authorised.  
**Actions forbidden:** deploy, migrate, commit to main, push release branch, open/update production release PR.

## Identity

| Field | Value |
|---|---|
| Admin branch | `rescue/local-atomic-fare-modification-20260915` (**local only**) |
| Admin worktree | `/Users/admin/ONECAB/_recovery/atomic-fare-mod-20260915/worktrees/admin` |
| Admin base SHA | `b4ad7212b70ea6f82efdd8faac31598daf955818` (`origin/main`) |
| Premium companion branch | `rescue/local-atomic-fare-modification-20260915` (**local only**) |
| Premium worktree | `/Users/admin/ONECAB/_recovery/atomic-fare-mod-20260915/worktrees/premium` |
| Premium base SHA | `b7692483eecbbdc3fe329e8de9b2129d23457c4e` (`origin/main`) |
| Recovery root | `/Users/admin/ONECAB/_recovery/atomic-fare-mod-20260915` |
| Admin patch SHA | `8b4ba29dbd71a1955da667b7034894d2880f24ba` |
| Premium patch SHA | `a5f018071743646ff142585fb178bc4b2d2d2380` |

Admin patch SHA: `8b4ba29dbd71a1955da667b7034894d2880f24ba`. Premium patch SHA: `a5f018071743646ff142585fb178bc4b2d2d2380`.

## Migration version registry

| Check | Result |
|---|---|
| Draft filename | `20260915120000_atomic_fare_increase_modification_claim.sql` |
| Release mark | **`INVALID_FOR_RELEASE`** |
| Collision | `origin/main` already has `20260915120000_accept_stacked_ride_max_queue_from_admin.sql` |
| Production tip (local+remote registries) | through **`20261112170000`** (`airport_charge_offer_stamp`) |
| Rename | **not performed** (per instruction) |
| Next verified unused version | **`20261112180000`** (absent from local `supabase/migrations/` and `origin/main`) |

## File manifest (Admin mergeable onto `origin/main`)

### Modified
- `.cursor/rules/revolut-incremental-auth-primary-lock.mdc`
- `supabase/functions/_shared/executeSameOrderIncrementSSOT.ts`
- `supabase/functions/_shared/revolutCompletionCapture.ts`
- `supabase/functions/_shared/revolutIncrementCoverage018.test.ts`
- `supabase/functions/_shared/revolutOrders.ts`
- `supabase/functions/confirm-trip-modification-payment/index.ts`
- `supabase/functions/stop-workflow/index.ts`

### Added
- `supabase/functions/_shared/tripModificationPaymentGateSSOT.ts`
- `supabase/functions/_shared/tripModificationPaymentGateSSOT.test.ts`
- `supabase/functions/_shared/atomicFareIncreaseClaimMapping.test.ts`
- `supabase/migrations/_draft_review_only/20260915120000_atomic_fare_increase_modification_claim.sql`
- `supabase/migrations/rollback/rollback_20260915120000_atomic_fare_increase_modification_claim.sql`
- `supabase/tests/atomic_fare_increase_modification_claim_sim.sql`
- `supabase/tests/atomic_fare_increase_modification_claim_parse_rollback.sql`
- `supabase/tests/atomic_fare_increase_modification_claim_parallel.sh`
- `docs/drafts/atomic-fare-modification/*` (this report + companions)

## File manifest (Premium companion)

- `src/lib/tripTracking.ts` — `paymentProcessing` fields on action response
- `src/pages/WhatsAppTrack.tsx` — HTTP 202 copy + local disable of re-confirm while reconciling

## Companion (preserved, not mergeable onto Admin `origin/main` alone)

`docs/drafts/atomic-fare-modification/companions/`

- `guest-trip-action.index.ts` — full Edge wrapper with exact 202 copy  
- `guest-trip-action.202-copy.patch` — diff vs overnight WIP `774490e3`

**Why companion:** `guest-trip-action` and helpers (`whatsappGuestBookingSSOT`, `whatsappPassengerInvoke`, `guest-trip-status`) are **not** on Admin `origin/main`. They live on WhatsApp guest-payment rescue history. Shipping them here would contaminate clean Admin tip scope.

## Dependency map

```
WhatsAppTrack / tripTracking (premium)
  → guest-trip-action (companion / WhatsApp guest rescue; not on origin/main)
    → confirm-trip-modification-payment (this branch)
      → decideFromPreauthInvokeResult / classifyIncrementCoverage (MK-260915-002 gate)
      → claim_and_apply_fare_increase_modification (draft SQL INVALID_FOR_RELEASE)
        → advance_trip_change_after_payment (existing DB SSOT)
stop-workflow complete_trip
  → trip_has_unresolved_fare_increase_modification (draft SQL)
executeRevolutTripCompletionCapture
  → trip_has_unresolved_fare_increase_modification (draft SQL)
```

**Deploy coupling:** Edge that calls the new RPCs must not ship without a renamed, reviewed migration. Migration must not ship without Edge.

## Future release preflight (required before any apply)

1. **ADDITIONAL_AUTHORISATION_CONFIRMED duplicates** — query existing rows that would violate `uq_psa_additional_auth_confirmed_per_modification` once `trip_change_request_id` is backfilled or newly written.
2. **Unresolved fare-increase modifications** — inventory `trip_change_requests` with `fare_delta_pence > 0` and status in (`payment_required`,`payment_pending`,`payment_confirmed`); decide resolve-or-cancel before enabling completion gate.
3. **Existing apply-event collisions** — if any manual/backfill rows would hit `uq_trip_modification_apply_events_request`, clear or map first.
4. **RPC owner / SECURITY DEFINER / search_path / grants** — confirm `claim_and_apply_*` and `trip_has_unresolved_*` remain `SECURITY DEFINER`, `search_path=public`, execute **service_role only**.
5. **Every completion / capture / remediation caller** — audit all paths that complete trips or capture Revolut holds for the new unresolved-mod gate (stop-workflow, revolutCompletionCapture, admin capture/remediation).
6. **Migration + committed-file statement hashes** — record sha256 of forward SQL, rollback SQL, and every Edge file in the release commit; compare to review manifest.
7. **Rollback data-loss guard** — rollback must fail closed if `trip_modification_apply_events` has rows or `payment_session_authorisations.trip_change_request_id` is populated (implemented in draft rollback).

## Rollback plan (draft)

1. Ensure Edge no longer requires the new RPCs.  
2. Run fail-closed rollback SQL (refuses populated audit/claim column).  
3. Only if counts are zero: drop functions, empty events table, indexes, unbound column.

## Tests already proven (local non-prod)

| Check | Result |
|---|---|
| BEGIN/ROLLBACK parse harness | PASS |
| Serial claim idempotency | 1 apply + 1 ALREADY_APPLIED; delta 311; 1 event; 1 auth; wallet/capture 0 |
| Two parallel psql confirms | PARALLEL_CONCURRENCY_PASS |
| Deno gate + mapping | 19 passed |

Re-run from this worktree before any future release review.

## Secret / binary scan

See `notes/secret_binary_scan.txt` in the recovery root.

## Stop

Workstream preserved. Resume **dirty-repository recovery** on the original working trees; do not continue feature implementation. MK-260915-002 remains frozen evidence.


## Final patch SHAs (recovery)

- Admin: `052fcbc67ac2e5fd248fe3bc6c4a75be0ebf60f7`
- Premium: `a5f018071743646ff142585fb178bc4b2d2d2380`
