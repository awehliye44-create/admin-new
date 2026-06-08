# P0: Admin Active Trips Stale Searching — Admin Panel Report

See canonical backend report: [onecab-comfy-ride/docs/p0-admin-active-trips-stale-searching-expiry-report.md](../../onecab-comfy-ride/docs/p0-admin-active-trips-stale-searching-expiry-report.md)

## Admin-specific changes

| File | Change |
|------|--------|
| `src/lib/adminActiveTripFilter.ts` | Exclude unassigned searching trips past `searching_expires_at` |
| `src/pages/ActiveTrips.tsx` | Filter fetched rows before render |
| `src/hooks/useSidebarCounts.ts` | Accurate badge count with same filter |
| `src/pages/Dashboard.tsx` | Active trips stat uses same filter |
| `src/test/adminActiveTripFilter.test.ts` | Unit tests (3 passed) |

## Admin query source

- **Table:** `trips` (direct PostgREST, not a view/RPC)
- **Filter:** `status IN ACTIVE_TRIP_DB_STATUSES` from `src/lib/activeTripStatuses.ts`
- **Gap (fixed):** No server-side `searching_expires_at` predicate — stale `searching` rows with elapsed window were included

## After deploy

MK-260605-024 and MK-260605-021 should **not** appear once backend terminalizes them (or immediately via client filter if still `searching` with past `searching_expires_at`).
