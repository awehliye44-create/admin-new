# Stacked rides — deploy notes (DO NOT DEPLOY FROM THIS DOC ALONE)

Audited production on 2026-08-06. Apps are wired locally; backend matching still blocked until these deploys.

## Production SSOT (confirmed live)

| Object | Role |
|--------|------|
| `global_dispatch_settings` (singleton) | Admin Auto-Dispatch Rules stacked knobs |
| `accept_stacked_ride(offer, driver, current_trip)` | Sets `trips.status='queued'`, `stack_position`, links `stacked_trip_id` |
| `accept_ride_offer` | Normal active assign only — must NOT be used for stacked |
| `promote_stacked_trip` | Called from `complete_trip_and_promote_next` |
| `get_driver_queued_trips` | Driver queue hydrate |
| Edge `auto-dispatch` | Real stacked offer creator (Haversine + Admin knobs + commitment gates) |
| Edge `accept-trip` | Must route busy drivers to `accept_stacked_ride` |
| Edge `request-trip-modification` | Reject `queued` with `STACKED_TRIP_MODIFICATION_BLOCKED` |

## Critical production bugs (matching)

1. **`tr_dispatch_trip_offers` → wrong overload**  
   Calls `dispatch_trip_offers(id, true)` (boolean) = idle-only, no `is_stacked`.  
   Fix migration: `20260915120100_stacked_dispatch_trigger_route_to_text_overload.sql`

2. **Text overload `stack_ok` compares `active_count` to `max_stacked_rides`**  
   With Admin max queued = 1, any driver with 1 active trip is rejected (`stacked_cap_reached`).  
   Must compare **queued count** to `max_stacked_rides`, require **exactly one** active trip.

3. **`accept_stacked_ride` hard-caps via `stacked_trip_id IS NOT NULL`**  
   Ignores Admin `max_stacked_rides`.  
   Fix migration: `20260915120000_accept_stacked_ride_max_queue_from_admin.sql`

4. **Edge `auto-dispatch` hard-coded fallbacks** (audited source under `.tmp/stacked-rides-audit/`)  
   Examples: `|| 3`, `|| 10`, `|| 5`, `|| 2000`, `|| 1`.  
   Required: fail closed when Admin knobs missing/invalid; log structured reason; do not offer.

5. **Admin allow_\* flags**  
   Present in `global_dispatch_settings` + Admin UI. Consumed in edge auto-dispatch; **not** in SQL `dispatch_trip_offers` text overload.

## Evidence

- `ride_offers.is_stacked=true` last 30 days: **0**
- `trips.status='queued'` last 30 days: **0**
- `trips.stacked_trip_id` set last 30 days: **0**

## Deploy order (when approved)

1. Apply `20260915120000_accept_stacked_ride_max_queue_from_admin.sql`
2. Apply `20260915120100_stacked_dispatch_trigger_route_to_text_overload.sql`
3. Replace `dispatch_trip_offers(uuid, text)` stack_ok / queue-count / allow_\* / fail-closed (full function body from prod + edits)
4. Deploy edge `auto-dispatch` (fail-closed stacked knobs; queue count vs `max_stacked_rides`)
5. Deploy edge `accept-trip` (stacked route) + `request-trip-modification` (STACKED block)
6. Ship Driver + Customer JS builds (no EAS unless approved)
7. Ahmed device smoke

## App wiring already done (local)

- Driver stacked accept → `accept_stacked_ride` RPC
- Driver no longer hard-gates max queue = 1 in offer presenters
- Customer queued status copy + tracking/edit/GPS publish off
