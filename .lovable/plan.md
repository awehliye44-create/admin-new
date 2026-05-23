# Global Dispatch Config Consolidation + Fixes

Strict scope: simplify configuration only. Do **not** touch dispatch scoring engine, PostGIS, wave logic, live tracking, or active trip code paths.

## 1. Database (migration)

Extend `global_dispatch_settings` (singleton) to be the **only** dispatch config source. Add every field currently per-SA in `dispatch_settings`, store all radii as **meters**:

New / ensured columns on `global_dispatch_settings`:
- `start_radius_meters`, `expand_radius_meters`, `max_radius_meters` (already exist)
- `shortlist_limit`, `wave1_size`, `wave2_size`, `wave3_size`
- `wave1_offer_expiry_seconds`, `wave2_offer_expiry_seconds`, `wave3_offer_expiry_seconds`, `offer_expiry_seconds`, `accept_timeout_seconds`
- `distance_penalty_per_meter` (converted from per_km), `waiting_bonus_per_minute`, `max_waiting_bonus_minutes`, `fairness_idle_minutes`, `fairness_boost_score`
- `max_driver_find_time_minutes`
- Stacked: `stacked_rides_enabled`, `max_stacked_rides`, `stacked_search_radius_meters`, `stacked_min_trip_distance_meters`, `stacked_max_detour_minutes`, `stacked_offer_window_minutes`, `stacked_priority_mode`, `stacked_driver_incentive`, `stacked_rider_discount`, `stacked_show_eta_to_driver`, `stacked_allow_rider_opt_out`
- Scheduled & system flags: scheduled_rides_enabled, min_advance_time_minutes, max_advance_days, waiting_time_grace_period_minutes, scheduled_ride_incentives_enabled, scheduled_response_window_minutes, urgent_dispatch_trigger_minutes_before_pickup, locked_driver_response_minutes, scheduled_urgent_card_label, enable_scheduled_to_urgent_conversion, enable_logging, simulate_mode, block_multiple_active_rides, cancel_protection, driver_fare_display

Backfill the singleton row from the existing global `dispatch_settings` row (where `service_area_id IS NULL`), converting km→meters.

**Drop** `public.dispatch_settings` table entirely (no commented fallback) after backfill.

RLS: admin-only write, authenticated read (matches current pattern).

## 2. Admin UI — `src/pages/AutoDispatchRules.tsx`

- Remove `Service Area` dropdown, `useServiceAreas`, `serviceAreaId` state and switching logic — permanently delete.
- Read/write via `global_dispatch_settings` singleton (`.eq('singleton', true).single()`).
- Keep all tabs (Scoring, Stacked, Scheduled, System) and all existing inputs working identically.
- Distance fields: store **meters** in DB, display in **km** (single unit, no per-region resolution). Add helpers `metersToKm`, `kmToMeters`.
- Header copy: "Global Auto-Dispatch Configuration — applies to all service areas".

## 3. Edge function — `supabase/functions/dispatch-drivers/index.ts`

- Replace `dispatch_settings` query with `global_dispatch_settings` singleton fetch. No per-SA branching, no per-SA fallback.
- `parseSettings()` reads `*_meters` directly (no km conversion in backend at all).
- **Radius expansion fix**: build `radiusStepsMeters = [start, expand, max]` from meters columns and pass `radiusMeters` directly into `find_nearby_drivers(p_radius_meters)` on each iteration (current loop already does this — verified the bug is the stale `dispatch_settings` row using km that may have wrong values; switching to meters singleton fixes it). Add an `console.log` per iteration with the actual radius used.
- Stacked rides: use `stacked_min_trip_distance_meters` (compare to `nd.distance_meters` directly — no km conversion). Use `max_stacked_rides` and `stacked_rides_enabled` from singleton.

## 4. Edge function — `supabase/functions/schedule-dispatch/index.ts` and any other reader of `dispatch_settings`

Audit & migrate all callers to `global_dispatch_settings`. List of files to update:
- `supabase/functions/dispatch-drivers/index.ts`
- `supabase/functions/schedule-dispatch/index.ts`
- `supabase/functions/find-drivers/index.ts` (if any)
- `supabase/functions/dispatch-trip/index.ts`
- `supabase/functions/validate-scheduled-booking/index.ts`

(Will grep before editing.)

## 5. Mobile-stable API fields

Where the apps consume dispatch settings (config endpoints / trip offer payloads), expose stable, typed fields:
```
{
  stacked_rides_enabled: boolean,
  max_active_rides_per_driver: number,   // alias of max_stacked_rides + 1
  start_radius_meters: number,
  expand_radius_meters: number,
  max_radius_meters: number
}
```
Booleans/numbers only (no nulls — safe defaults applied server-side).

## 6. Keep intact (do not touch)

- `find_nearby_drivers` RPC
- Wave dispatch loop, scoring formula, fairness/waiting bonus logic
- Live tracking (`upsert-driver-location`, `FleetTracking`, `ActiveTrips`)
- `accept-trip`, `decline-trip`, `complete-trip`, trip offers table

## Files touched

- `supabase/migrations/<new>.sql`
- `src/pages/AutoDispatchRules.tsx`
- `supabase/functions/dispatch-drivers/index.ts`
- `supabase/functions/schedule-dispatch/index.ts` (if reads dispatch_settings)
- Any other edge fn referencing `dispatch_settings`
- `src/integrations/supabase/types.ts` (auto-regen)
- Update memory: `mem://features/global-dispatch-settings` to reflect deprecation of `dispatch_settings` table

Approve to proceed.
