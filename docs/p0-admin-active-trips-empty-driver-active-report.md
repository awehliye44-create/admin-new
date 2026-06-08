# P0: Admin Active Trips empty while driver shows active trip

**Date:** 2026-06-02  
**Prod Supabase:** `thazislrdkjpvvghtvzo` (ONECAB ltd)  
**Repos:** `admin-new`, `drive-hub-buddy`

## Symptom

Driver app shows an active trip (e.g. waiting at pickup, alerts firing). Admin **Active Trips (Real-time)** page lists **no trips** (empty state).

## Root cause

**Admin status filter too narrow** — not stale driver UI alone, not payment capture, not map.

The Active Trips query filters `trips.status` with a fixed allow-list. That list included legacy values (`arrived`, `in_progress`, `started`) but **omitted production statuses** written by dispatch / `stop-workflow` / `accept-offer` after assignment:

| DB status (prod) | Driver UI (`dbStatusToRideStatus`) | Was in admin filter? |
|------------------|-------------------------------------|----------------------|
| `driver_en_route`, `enroute_to_pickup`, `en_route_to_pickup` | `ACCEPTED` (en route) | **No** |
| `arrived_pickup`, `arrived_at_pickup`, `waiting`, `pickup_waiting` | `ARRIVED_PICKUP` (at pickup / waiting) | **No** |
| `confirmed` | `ACCEPTED` | **No** |

A driver “waiting at pickup” (Priestley Drive–style) almost certainly has `trips.status` in **`arrived_pickup`** or **`waiting`**, which the admin query excluded → **zero rows** while the driver app correctly hydrates from `drivers.current_trip_id` + realtime and maps DB status to UI.

Secondary gaps (same class of bug):

- **Sidebar badge** (`useSidebarCounts`) used an even smaller list (`pending`, `accepted`, `arrived`, `in_progress`, `driver_assigned`).
- **Fleet Tracking** trip overlay used only `accepted`, `arrived`, `in_progress`.
- **Dashboard** “Active Trips” stat used `arriving` (not a DB status).

## Driver app vs admin (not a cache-only mismatch)

| Layer | Behavior |
|-------|----------|
| Driver | `useRideWorkflow` + `drivers.current_trip_id`; `localStorage` `driver_active_trip_id`; UI statuses `ACCEPTED` / `ARRIVED_PICKUP` from `dbStatusToRideStatus` in `src/types/ride.ts`. |
| Admin | PostgREST `trips` SELECT with `.in('status', …)`; requires **admin** JWT (`has_role(..., 'admin')` RLS). |

If DB trip were `cancelled` / `customer_cancelled` but driver UI stale, admin would also show empty (correct for DB). This incident matches **live assigned trip with non-legacy status**, not terminal DB state.

## RLS / project URL

- Admin client: `VITE_SUPABASE_URL` + publishable key (`src/integrations/supabase/client.ts`).
- Policy: `"Admins can read all trips"` → `has_role(auth.uid(), 'admin')` (migration `20260112151953_…`).
- **Anon key** returns `[]` for trips (expected); empty page when logged in as admin is **not** explained by wrong project if other admin pages load data.
- `trips.assigned_driver_id` **does not exist** on prod (42703 if selected); assignment uses **`driver_id`** only.

## Prod DB probe (read-only, anon)

Could not read trip rows without admin session:

- `GET /rest/v1/trips?…` with publishable key → `[]` (RLS).
- `drivers?driver_code=eq.MK001|LAH001` → `[]` (RLS).
- Project ref on responses: `thazislrdkjpvvghtvzo` (matches prod).

**After deploy:** as admin, run Active Trips refresh or SQL:

```sql
SELECT id, trip_number, status, driver_id, pickup_address, passenger_name, cancelled_at, created_at
FROM trips
WHERE status IN ('driver_en_route','arrived_pickup','waiting','accepted','driver_assigned')
  AND created_at > now() - interval '2 hours'
ORDER BY created_at DESC
LIMIT 20;
```

Join driver: `SELECT id, driver_code, current_trip_id FROM drivers WHERE driver_code IN ('MK001','LAH001');`

## Fix (minimal)

**File:** `admin-new/src/lib/activeTripStatuses.ts` — single SSOT list aligned with `drive-hub-buddy` (`customerLiveTripStatuses`, `rideAssignmentFinalize`, dispatch search states).

**Wired into:**

- `src/pages/ActiveTrips.tsx` — query + status badge labels for new statuses
- `src/hooks/useSidebarCounts.ts` — badge count
- `src/pages/FleetTracking.tsx` — driver ↔ trip mapping
- `src/pages/Dashboard.tsx` — active trip stat

No payment capture changes. No driver app change required for admin visibility; recommend driver **pull-to-refresh / reopen trip** if DB is terminal but UI is stale.

## Verify (post-deploy)

1. Log into admin (role `admin`), open **Active Trips** — trip with `arrived_pickup` / `driver_en_route` appears.
2. Sidebar **Active Trips** badge matches row count.
3. **Fleet Tracking** — on-trip driver shows linked trip card.
4. Optional: confirm prod row `status` for reported trip via SQL above.

## Files changed

| Repo | Path |
|------|------|
| admin-new | `src/lib/activeTripStatuses.ts` (new) |
| admin-new | `src/pages/ActiveTrips.tsx` |
| admin-new | `src/hooks/useSidebarCounts.ts` |
| admin-new | `src/pages/FleetTracking.tsx` |
| admin-new | `src/pages/Dashboard.tsx` |
| admin-new | `docs/p0-admin-active-trips-empty-driver-active-report.md` (this file) |

Rebuild admin dev server not required for end users; redeploy admin static build / hosting for prod.
