# #118 — Stale `drivers.current_trip_id` after completion

**Severity:** Critical #110 blocker  
**Evidence trips:** MK-261126-006 / MK-261126-007 → dispatch exclusion on MK-261126-014  
**Stage D:** true/true · Atomic STOP

## Exact root cause

`stop-workflow` `complete_trip` wrote `status=completed` first, then ran tip/payment. The only non-stacked `current_trip_id` clear lived in `complete_trip_p2` **after** that block.

#113 `voidTipWindowTen` ReferenceError threw inside the tip-window block → HTTP 500 → **p2 never scheduled** → pointer left on completed trips for hours.

#113 rename to `logTipWindowTenDeferred` fixed the exception but **did not** move the clear before side-effects — recurrence class remained for any later throw / early return.

No DB trigger cleared the pointer on completion (cancel paths already CAS-cleared).

## Fleet audit (read-only, then healed)

| Category | Count |
|----------|------:|
| Stale → completed | **2** (MK0006, MK0007 only) |
| Stale → cancelled/no_show/expired | 0 |
| Missing trip | 0 |
| Ownership mismatch | 0 |
| Active trip pointer missing | 0 |

MK0007: 0.4 m from MK-261126-014 pickup, ~5 h stale on MK-261126-006.  
MK0006: 6.6 m, ~5 h stale on MK-261126-007. Both `stacked_active_count_invalid`.

## Automatic recovery evidence

`SELECT reconcile_stale_driver_current_trip(NULL, 100)` → `cleared_count: 2`  
(`STALE_CURRENT_TRIP_CLEARED` for MK0006/MK0007).  
Post-check: both `current_trip_id IS NULL`, `remaining_stale_completed = 0`.

## Permanent correction

1. **DB trigger** `trips_clear_driver_current_trip_on_terminal` — CAS clear on terminal transition; skip when queued stacked child exists.  
2. **RPC** `reconcile_stale_driver_current_trip` — bounded fleet heal (service_role).  
3. **On-search heal** AFTER INSERT searching/pending.  
4. **Edge** early CAS clear after completion write, before tip/payment; idempotent Complete also heals; p2 clear is CAS.  
5. **auto-dispatch** reconciles before eligibility; stacked pool skips terminal pointers.  
6. **Stacked promote cron** runs the same reconcile.

## MK-261126-008 (read-only)

Scheduled 27 Nov 06:40 UTC, `scheduled_status=driver_assigned`, `confirmed_driver_id=MK0006`, `broadcast_enabled=true`, hold reason null.  
MK0006’s stale pointer is cleared — assignment for 008 unchanged (no cancel/mutate). Activation/fallback still subject to normal scheduled gates.

## #117

Remains a **separate** Customer session-recovery critical (not closed by #118).
