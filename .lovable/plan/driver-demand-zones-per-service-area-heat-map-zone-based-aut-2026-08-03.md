# Driver Demand Zones — Per-Service-Area Heat Map + Zone-Based Automatic Surge

## Part 1 — Audit of what exists today

### 1. Current architecture
- Admin page `src/pages/DriverDemandZones.tsx` reads `driver_demand_zones` directly from the browser (no RPC), with Region / Service area / Source / Status filters, search, map + list tabs, manual add/edit/delete, and a "Recompute from trips" button.
- Map: `src/components/maps/DriverDemandZonesMap.tsx` (Mapbox) + `src/lib/demandZoneGeojson.ts` (circle rings from `center_lat/lng/radius_meters`) + `src/lib/demandZoneMapStyle.ts` (hard-coded LOW/MEDIUM/HIGH colours, shared by contract with the driver app).
- Help copy: `src/components/dispatch/DriverDemandZonesHelpPanel.tsx` (hard-codes "45 minutes", "every 2 minutes", "4+ / 2-3 / 1 open trips").

### 2. Tables / functions / jobs in use
- Table `driver_demand_zones`: `id, name, center_lat, center_lng, radius_meters (default 500), demand_level (text, default MEDIUM), active, region_id, service_area_id, source ('manual'|'computed'), created_at, updated_at`.
- DB functions: `compute_driver_demand_zones_sweep()`, `compute_driver_demand_zones_sweep_has_work()`, `driver_demand_zone_geometry_is_valid()`, `driver_demand_zones_enforce_valid_geometry()` trigger, `list_driver_own_demand_zones()` (driver app read, scoped by driver service areas / region).
- Cron: `compute-driver-demand-zones-every-2m` (`*/2 * * * *`, active) → `net.http_post` → edge function `compute-driver-demand-zones`.
- **Gap found:** the edge function `compute-driver-demand-zones` is NOT present in this repo (`supabase/functions/`), although it is deployed and invoked by both cron and the admin button. Its logic must be re-created locally before it can be safely changed.

### 3. Zone ↔ service area relationship
- `service_area_id` and `region_id` are both nullable. `NULL` service area = "global" zone, visible to drivers in any/matching region. Filtering is client-side only; there is no per-service-area configuration of any kind.

### 4. Recompute interval / lookback
- Interval: hard-coded cron `*/2`. Lookback: documented as 45 minutes of open unassigned trips, and thresholds 1 / 2-3 / 4+ are hard-coded inside the edge function. Nothing is admin-configurable, nothing is per service area.

### 5. Manual zone contract
- Manual zones (`source='manual'`) are admin CRUD, never touched by recompute, purely advisory in the driver app. **No pricing contract exists today** — no fare code reads `driver_demand_zones`. So manual zones stay advisory-only in this phase.

### 6. Fare estimate / quote workflow
- `supabase/functions/estimate-fare` resolves service area → `fare_pricing_settings` + `service_area_vehicle_pricing` → `_shared/fareEngine.ts`.
- `fareEngine` already has `enable_surge` + `surge_multiplier_default` + `zone_multiplier` applied service-area-wide (`rawSubtotal * surge * zone * traffic`). This is exactly the "whole service area surge" the task forbids for the new feature.
- **Gap:** no quote ID, no quote expiry, no locked multiplier, no zone attribution on the estimate response; nothing stored on the trip at confirmation.

### 7. Gaps summary
No per-SA heat-map config, no admin colours, no proposed/confirmed level or hysteresis, no zone-level surge, no quote lock, no demand-zone audit trail, no granular permissions (page is guarded only by the generic admin page gate), and the compute edge function is missing from the repo.

---

## Part 2 — Implementation plan (nothing deployed; each step approved separately)

### Migration A — configuration
`service_area_demand_zone_settings` (one row per service area, PK `service_area_id`):
heat-map enabled, recompute interval minutes (default 2), open-trip max lifetime minutes (default 6), low/medium/high min+max thresholds, consecutive checks required (default 2), zone radius metres, manual zones enabled, `colour_low/medium/high` (`#RRGGBB`, CHECK-validated), surge enabled (default false), `multiplier_low` (default 1.00) / `multiplier_medium` / `multiplier_high` (nullable), `max_multiplier`.
Threshold and multiplier ordering enforced by a validation trigger (not CHECK). GRANTs + RLS: read for authenticated admins, writes only through RPCs.

### Migration B — zone state + audit
- `driver_demand_zones` gains: `proposed_demand_level`, `confirmed_demand_level`, `consecutive_match_count`, `open_trip_count`, `last_evaluated_at`, `current_multiplier`.
- `driver_demand_zone_settings_audit` (immutable: service area, actor id, actor role, previous/new jsonb, correlation id, created_at) and `driver_demand_zone_evaluations` (previous/new confirmed level, proposed level, counts, multipliers, evaluated_at).

### Migration C — RPCs + permissions
- `admin_save_demand_zone_settings(...)` — SECURITY DEFINER, validates all ranges/colours/multipliers, writes audit, enforces action keys via existing `staff_has_action` / `is_super_admin`.
- `resolve_zone_surge(p_lat, p_lng, p_service_area_id)` — returns zone id, confirmed level, multiplier (1.00 when no zone / surge disabled). Single SSOT for pricing.
- New action keys in `shared/rolesPermissionsSSOT.ts` + seeded rows in `role_action_permissions`: `demand_zones.view`, `.recompute`, `.configure_heatmap`, `.configure_colours`, `.configure_surge`, `.view_audit`.

### Backend functions
- Recreate `supabase/functions/compute-driver-demand-zones` locally from the deployed contract, then rewrite it to: read per-SA settings, count distinct open unassigned trips within the configured lifetime, derive proposed level from configured thresholds, apply consecutive-check hysteresis to set confirmed level, write evaluation history. Same function serves cron and the manual button (a `service_area_id` argument scopes the manual run).
- `estimate-fare`: call `resolve_zone_surge` on the pickup coordinate and return `base_fare_before_surge`, `applied_multiplier`, `surge_amount`, `final_fare`, `service_area_id`, `zone_id`, `confirmed_level`, `quote_id`, `quote_expires_at`. Client-sent multipliers are ignored.
- Booking confirmation path stores the locked multiplier/amount/zone/level on the trip; a pickup change invalidates the quote.

### Admin UI (existing page only)
- "Heat Map & Surge Settings" button next to "Recompute from trips", opening a sheet with the three sections (heat map, colours with picker + hex + live preview + reset, surge).
- "All service areas" mode: view-only with the required message.
- Map/legend read colours from the selected service area's settings; zone popups show confirmed level, open trip count, current multiplier, last recomputed at; surge-enabled state shown separately from colour.
- Help panel copy switched from hard-coded numbers to the loaded settings.

### Tests
Vitest suites for a new pure module `shared/demandZoneSurgeSSOT.ts` covering: per-SA isolation of thresholds/colours/multipliers, threshold and multiplier validation, hex validation/normalisation, hysteresis (first reading does not confirm, second does, return to Low needs the configured count), zone-based multiplier resolution (inside High zone, outside any zone = 1.00, other zone unaffected), surge disabled = 1.00, colour changes never affect price, client multiplier ignored, quote lock retained, all-areas mode read-only, and permission guard outcomes.

### Deployment / rollback (not executed now)
Order: Migration A → B → C → edge functions → admin release. Rollback: settings rows default to heat map on / surge disabled, so dropping the new columns/tables restores current behaviour; `estimate-fare` falls back to multiplier 1.00 whenever `resolve_zone_surge` is unavailable.

### Remaining risks
- The deployed `compute-driver-demand-zones` source is not in the repo — its exact grid/cell logic must be reconstructed and confirmed before the rewrite.
- Existing `fare_pricing_settings.enable_surge` / `surge_multiplier_default` remain a service-area-wide multiplier; per your cleanup policy these should be retired in the same phase to avoid two surge systems — confirm and I will remove them.
