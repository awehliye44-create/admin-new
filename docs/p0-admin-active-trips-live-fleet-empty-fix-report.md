# P0: Admin Active Trips & Live Fleet Tracking empty — fix report

**Date:** 2026-06-07  
**Prod Supabase:** `thazislrdkjpvvghtvzo` (ONECAB ltd)  
**Repo:** `admin-new`

## Symptom

Admin **Active Trips (Real-time)** and related ops widgets show **empty** while prod has live trips (e.g. `searching_new_driver`, `arrived_at_pickup`). **Live Fleet Tracking** does not mark on-trip drivers correctly.

## Root cause

**Admin trip status filter too narrow — fix was authored but never committed to `main`.**

| Layer | Finding |
|-------|---------|
| **Data path** | Direct PostgREST on `trips` / `drivers` — **no** `admin-active-trips`, `admin-fleet`, or `live-fleet` edge functions |
| **503 edge functions** | **Not involved** — widgets do not call those endpoints |
| **RLS** | Working — Trip History / Driver Wallet load via same admin JWT + `has_role(..., 'admin')` policies |
| **Service area / region filter** | Not applied on Active Trips or Fleet Tracking queries (by design) |
| **Stale Lovable bundle** | **Yes** — `src/lib/activeTripStatuses.ts` and wiring existed locally as **untracked** files; prod still runs committed code with legacy status list |
| **Wrong status filter** | **Primary cause** |

### Prod probe (2026-06-07)

```sql
-- Active non-terminal trips (24h)
status                  | cnt
------------------------+-----
arrived_at_pickup       | 1
searching_new_driver    | 1

-- Known trip codes
MK-260607-012  expired
MK-260607-013  searching_new_driver  (no driver)
MK-260607-014  arrived_at_pickup     (driver Ahmed Osman)
```

| Filter | Matching rows (24h) |
|--------|---------------------|
| **Old** admin list (`pending`, `searching`, `accepted`, `arrived`, `in_progress`, …) | **0** |
| **New** `ACTIVE_TRIP_DB_STATUSES` | **2** |

Production dispatch writes statuses such as `searching_new_driver`, `arrived_at_pickup`, `driver_en_route` that the deployed admin UI excluded.

### Live Fleet Tracking (secondary)

Fleet page loads drivers correctly (1 approved/online driver in prod) but linked trip overlay used only `accepted`, `arrived`, `in_progress`. Driver **Ahmed Osman** is assigned to `MK-260607-014` (`arrived_at_pickup`) but `drivers.current_trip_id` is null — trip linkage uses `trips.driver_id`, so fixing the status list restores **On Trip** badge/card.

Dashboard **On Trip** count still uses `drivers.current_trip_id` (data sync gap, out of scope for this fix).

## Comparison with working pages

| Page | Query pattern | Why it works |
|------|---------------|--------------|
| **Trip History** | Broad date-range `trips` select, no active-status allow-list | All statuses visible |
| **Driver Wallet** | `driver_financial_summary` view / edge fallback | Unrelated to trip status filter |
| **Active Trips** | `.in('status', legacy_list)` | **Excluded prod statuses → 0 rows** |

## Fix (minimal, frontend only)

Committed SSOT + wiring:

| File | Change |
|------|--------|
| `src/lib/activeTripStatuses.ts` | Canonical `ACTIVE_TRIP_DB_STATUSES` aligned with dispatch / driver app |
| `src/lib/adminActiveTripFilter.ts` | Exclude stale unassigned searching past `searching_expires_at` |
| `src/pages/ActiveTrips.tsx` | Query + render via SSOT list + stale filter |
| `src/pages/FleetTracking.tsx` | Trip overlay uses SSOT list |
| `src/hooks/useSidebarCounts.ts` | Badge count via SSOT + stale filter |
| `src/pages/Dashboard.tsx` | Active trips stat via `isActiveTripDbStatus` + stale filter |
| `src/test/adminActiveTripFilter.test.ts` | Unit tests (3 passed) |

**Edge function deploy:** Not required — no backend change.

## Expected widget content after fix + Lovable publish

| Widget | Expected |
|--------|----------|
| **Active Trips** | **2 rows:** `MK-260607-013` (Searching Driver), `MK-260607-014` (At Pickup / Ahmed Osman) |
| **Sidebar badge** | **2** |
| **Fleet Tracking** | **1 driver** (Ahmed Osman, online); **On Trip** badge with pickup snippet for MK-260607-014 |
| **Dashboard Active Trips** | Count includes trips in selected date range with active statuses (daily view includes today's 2) |

## Verify (post-deploy)

1. Publish admin frontend on Lovable (rebuild from `main`).
2. Log in as admin → **Active Trips** → refresh → see MK-260607-013 and MK-260607-014.
3. **Live Fleet Tracking** → Ahmed Osman shows **On Trip** with trip card.
4. Sidebar **Active Trips** badge = 2.

Optional SQL:

```sql
SELECT trip_code, status, driver_id, created_at
FROM trips
WHERE status IN ('searching_new_driver','arrived_at_pickup')
ORDER BY created_at DESC;
```

## Lovable publish note

**Required.** This is a static frontend fix only. After merge to `main`, trigger a **Lovable publish / redeploy** of the admin app so prod serves the new bundle. No Supabase edge function deploy needed.
