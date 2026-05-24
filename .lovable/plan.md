
# Phase 1 — Dispatch Scoring & Execution: Production Hardening

Scope: normal (immediate, non-scheduled, non-stacked) dispatch only. Stacked-quality rules and Scheduled-only fields untouched except where they share the same edge.

## What is already correct (do not change)

- `public.dispatch_trip_offers(uuid, text)` RPC = single dispatcher. Reads `global_dispatch_settings` singleton every call. Wave caps 7/9/13 and radii 7000/9000/13000 m proven in `dispatch_wave_snapshots`.
- `tr_trips_dispatch_after_insert` trigger on `public.trips` already auto-invokes the RPC on customer booking.
- `expire_stale_offers()` cron (10 s) → `maybe_advance_dispatch_after_offer_resolution(..., 'offer_expired')` → re-invokes the RPC for the next wave. Round-advance is idempotent via `dispatch_round_advance_log` unique constraint.
- Every selected driver already gets a `ride_offers` row (single `INSERT ... RETURNING` inside the RPC).
- `dispatch_wave_snapshots` is written for every round with `wave_cap`, `search_radius_meters`, `candidate_count`, `eligible_count`, `selected_count`, `offer_created_count`, `selected_drivers`, `previous_round_drivers`, `reason_for_next_wave`.

## Problems to fix

1. **Duplicate dispatcher path** — `supabase/functions/dispatch-trip` invokes the same RPC after the DB trigger already fired, producing a wasted call that returns `duplicate_trigger`. Customer/Manual booking flows currently call both. Single source: the DB trigger.
2. **Legacy `public.dispatch_settings` table still exists**, and `trg_sync_fare_pricing_to_dispatch_settings` keeps writing into it from `fare_pricing_settings`. No reader. Conflicts with the user "no legacy fallback" rule.
3. **`tr_dispatch_trip_offers()` trigger function** must swallow its own errors. A dispatch failure must never block the trip INSERT.
4. **Push delivery is not actually tracked.** `tr_send_push_on_ride_offer_insert` exists but FCM backend is missing (per memory). We need a `ride_offer_deliveries` row per offer so admin/ops can see delivery status; the actual FCM send stays as-is until the FCM backend lands.
5. **Dead UI knobs** in Admin → Auto-Dispatch Rules that nothing reads: `dispatch_mode`, `drivers_per_wave`, `wave_delay_seconds`, `shortlist_limit`, `driver_fare_display`, `offer_expiry_seconds` (generic), `accept_timeout_seconds`, `driver_response_timeout_seconds`. Per cleanup policy these must be permanently removed, not hidden.
6. **Hardcoded values surfaced**: `v_max_rounds=3`, degraded penalty `100`, `presence_max_age=60s`. Promote to admin so the screen is honest.

## Changes

### 1. Migration (single migration, no fallbacks)

- `DROP TRIGGER trg_sync_fare_pricing_to_dispatch_settings ON public.fare_pricing_settings`
- `DROP FUNCTION public.sync_fare_pricing_to_dispatch_settings()`
- `DROP TABLE public.dispatch_settings` (CASCADE — its only remaining trigger is its own `updated_at`).
- Add to `global_dispatch_settings`: `max_dispatch_rounds int NOT NULL DEFAULT 3`, `degraded_driver_penalty int NOT NULL DEFAULT 100`, `presence_max_age_seconds int NOT NULL DEFAULT 60`. Backfill row, then drop the dead columns `drivers_per_wave`, `wave_delay_seconds`, `shortlist_limit`, `dispatch_mode`, `driver_fare_display`, `offer_expiry_seconds`, `accept_timeout_seconds`, `driver_response_timeout_seconds`.
- Replace `public.dispatch_trip_offers` to:
  - read the three new fields,
  - replace `v_max_rounds := 3` with the admin value,
  - replace literal `100` with `v_g.degraded_driver_penalty`,
  - replace literal `60` with `v_g.presence_max_age_seconds`,
  - drop the second-redundant `SELECT ... FROM global_dispatch_settings` (one fetch at top).
- Replace `tr_dispatch_trip_offers()` so the `PERFORM dispatch_trip_offers(NEW.id, 'auto')` is wrapped in `BEGIN ... EXCEPTION WHEN OTHERS THEN ... insert into dispatch_round_advance_log + RAISE WARNING; END;` — the booking row must commit even if the RPC errors.
- Create `public.ride_offer_deliveries` ( `id uuid pk`, `ride_offer_id uuid fk → ride_offers(id) on delete cascade`, `driver_id uuid`, `channel text` ('fcm' | 'realtime'), `status text` ('queued' | 'sent' | 'delivered' | 'failed'), `error_code text`, `error_message text`, `attempted_at timestamptz default now()`, `delivered_at timestamptz`, `payload jsonb`). RLS: admins read all, drivers read own, service-role write.
- Replace `tr_send_push_on_ride_offer_insert` to also insert a `ride_offer_deliveries` row with `status='queued'` and channel based on `driver_presence.push_token`/`socket_connected` (no behavior change to FCM, just observability).

### 2. Edge function — `dispatch-trip`

Delete the function directory entirely (`supabase/functions/dispatch-trip/`). Remove from `supabase/config.toml`. The DB trigger is the only path for normal bookings. Manual-trip / admin "re-dispatch" call the RPC directly via `supabase.rpc('dispatch_trip_offers', { p_trip_id, p_trigger_reason: 'manual' })`.

Audit + update callers:
- `src/pages/ManualTrip.tsx` (uses `functions.invoke('dispatch-trip', ...)`) → switch to `.rpc('dispatch_trip_offers')`.
- Any other `supabase.functions.invoke('dispatch-trip'` call across `src/` and `supabase/functions/`.

### 3. Admin UI — `src/pages/AutoDispatchRules.tsx`

- Remove every input bound to the dead columns listed above (Scoring tab and System tab).
- Add Scoring inputs for `max_dispatch_rounds`, `degraded_driver_penalty`, `presence_max_age_seconds`.
- Keep wave1/2/3 size + wave1/2/3 expiry, radii, distance penalty, waiting bonus, fairness, all unchanged.
- Header note already says "Global". No service-area selector to remove.

### 4. Tests / verification

- `vitest`: keep existing tests; add a unit test only if a helper changes.
- Manual verification: open Admin → Auto-Dispatch Rules, save; place a test booking; confirm:
  - one `dispatch_round_advance_log` row per round (no `duplicate_trigger`),
  - `dispatch_wave_snapshots` written with new `wave_cap` / radius,
  - `ride_offer_deliveries` row per offer,
  - no rows landing in (gone) `dispatch_settings`.

## Files touched

- `supabase/migrations/<new>.sql`
- `supabase/functions/dispatch-trip/` (delete)
- `supabase/config.toml` (remove `[functions.dispatch-trip]`)
- `src/pages/ManualTrip.tsx` (caller switch)
- `src/pages/AutoDispatchRules.tsx` (drop dead inputs, add 3 new)
- Any other caller found by `rg "functions.invoke\\('dispatch-trip'"`
- Memory update: `mem://features/global-dispatch-settings` to record dropped columns + new ones, and removal of `dispatch-trip` edge.

## Explicitly NOT touched in Phase 1

- `accept-trip`, `decline-trip`, `schedule-dispatch`, `find-drivers`, `expire_stale_offers`, `maybe_advance_dispatch_after_offer_resolution`, `dispatch_round_advance_log`, scoring formula, stacked-quality rules (min distance / detour / same-direction / priority mode), scheduled-only fields, fare engine, live tracking.

Approve to proceed.
