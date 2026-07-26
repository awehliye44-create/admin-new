# Demand heatmap — automatic visibility (no Admin click required)

**Status:** live on production (`20260902140000`)

## How it works

1. Every 2 minutes `compute-driver-demand-zones-every-2m` runs.
2. When there are open unassigned trips (searching / offered / …) **or** leftover `source=computed` zones, it invokes `compute-driver-demand-zones`.
3. That edge function grids open pickups and writes `[AUTO] …` zones (existing algorithm — not reinvented).
4. When open demand ends, the next sweep still runs (because computed zones remain) and **clears** stale computed zones.

## Visibility

| Surface | Behaviour |
|---------|-----------|
| **Driver app** | Heatmap layers **on by default** (`demandZonesUiStore.visible = true`). Flame toggle only hides/shows; preference persisted. |
| **Admin** | `/driver-demand-zones` map shows active zones with valid geometry automatically. |

## Guards added

- Invalid geometry `(0,0)` / bad radius cannot stay **active** (trigger).
- Existing null-island manual zone deactivated.
- Driver RPC `list_driver_own_demand_zones` filters invalid geometry.
- Admin GeoJSON builder skips invalid / inactive zones.

## Important

Heat circles appear when the **existing** open-trip compute pipeline has demand.  
An empty map with no open searching trips is correct — we do not invent demand.

## Rollback

See header of `supabase/migrations/20260902140000_demand_zones_auto_visibility_guard.sql`.
