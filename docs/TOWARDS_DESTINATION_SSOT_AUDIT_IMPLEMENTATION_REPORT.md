# Towards Destination SSOT — Audit + Implementation Report

**Date:** 2026-08-01 (third adversarial pass)  
**Prod:** `thazislrdkjpvvghtvzo` (read-only — **not** modified)  
**Status:** Local A–F verified COMPLETE after third-pass residual fixes — **NOT applied / NOT deployed**

## Third-pass verdict: COMPLETE (local)

| clause | required | evidence (file:symbol) | residual |
|---|---|---|---|
| **A** Selection store + dispatch coords | Store lat/lng/formatted address/postcode/place_id; dispatch uses coords only | `set_driver_own_towards_destination` persists address/postcode/place_id/lat/lng/session; Driver `towardsDestinationAdapter.productionSource.activateDestination` sends all five; `mapFeature` sets `placeId`; auto-dispatch `destinationMap` uses lat/lng only | **None** (local) |
| **B** Directional matching | Detour + progress + SA/vehicle + normal/stacked; qualify `dropoff→dest < driver→dest + tolerance`; not arrival-radius / not postcode string | `towardsDestinationTripQualifies` + SQL twin `towards_destination_trip_qualifies`; auto-dispatch idle + stacked call it; stacked projects from active dropoff; SA/vehicle gates unchanged | **None** (local). Closed this pass: SQL rejects pickup/dropoff Null Island; Edge requires pickup+dropoff coords |
| **C** Stacked | No reject solely on `current_trip_id`; base AND stacked rules; project after active; max queued; no separate TD stacking | Idle hard-gate keeps `current_trip_id` null; stacked pool `.not("current_trip_id","is",null)` + stacked rules + TD filter; `max_stacked_rides` / pending stacked offers gate; set RPC has no `current_trip_id` reject | **None** |
| **D** Arrival | 500m default SA-configurable; complete + consume one; clear filter → normal if online | Columns default 500; `towards_destination_maybe_complete_on_location` + presence trigger + `update_driver_location` hook; `complete_session` clears filter (online drivers re-enter normal pool) | **None** (local). Closed this pass: orphan-filter arrival respects rolling limit before synthesizing consume |
| **E** Same-location | Reject; UK title/message; no session / no usage | set RPC haversine ≤ arrival → `destination_already_reached` + title/message; Driver Alert uses `result.title` / `result.message` | **None** |
| **F** Usage | 5 rolling 24h completions only; activate does not consume; usage JSON shape | Sessions SSOT + `towards_destination_usage_snapshot`; activate leaves usage unchanged; `usage{limit,completed_last_24h,remaining,window_type,next_available_at}` + legacy aliases | **None** |
| Alerts | No raw `daily_limit_reached` | `mapTowardsDestinationErrorUi` + screen Alerts | **None** |

### Prod live lag (read-only probe 2026-08-01)

Confirmed via Management API SQL + deployed Edge body (`auto-dispatch` v522):

| check | prod value |
|---|---|
| `global_dispatch_settings.towards_destination_daily_limit` | **3** |
| `towards_destination_matching_tolerance_meters` | **3000** (used as 3km radius semantics in Edge) |
| arrival / min_progress / max_detour columns | **absent** |
| `towards_destination_sessions` | **null** (table missing) |
| `set_driver_own_towards_destination` | 3-arg; **`v_uses := v_uses + 1` on activate** |
| `daily_limit_reached` payload | code only (no UK title/message) |
| `destination_already_reached` | **absent** |
| Edge TD filter | hardcoded `DESTINATION_MATCH_RADIUS_METERS = 3000` dropoff-near-dest (not directional) |
| `towardsDestinationTripQualifies` import | **absent** from deployed Edge |

## Gaps closed this third pass

1. **SQL `towards_destination_trip_qualifies`** now rejects Null Island on **pickup and dropoff** (parity with TS `coordsValid`).
2. **auto-dispatch** requires finite **pickup + dropoff** coords for TD drivers (no coercion via outer `pickupLat \|\| 0`).
3. **Orphan arrival** (active filter, no session row): clears filter always; synthesizes `destination_reached` consume **only if** rolling remaining > 0.
4. **Admin `types.ts`** `set_driver_own_towards_destination` Args bridged with optional `p_postcode` / `p_place_id`.
5. **Driver place-search test** updated to expect `placeId` (contract A mapping already shipped).

## Files / migrations (local only)

**Backend (`admin-new`)**
- `supabase/migrations/20260909120000_towards_destination_ssot_rolling_completions.sql` (**do not apply yet**)
- `supabase/functions/auto-dispatch/index.ts`
- `shared/towardsDestinationSSOT.ts`
- `shared/__tests__/towardsDestinationSSOT.test.ts`
- `src/pages/AutoDispatchRules.tsx`
- `src/integrations/supabase/types.ts` (partial column/RPC bridge; full regen after migrate)

**Driver (`onecab-driver-native`)**
- `src/features/towardsDestination/lib/mapTowardsDestinationError.ts` (+ test)
- `src/features/towardsDestination/data/towardsDestinationAdapter.ts` (+ test)
- `src/features/towardsDestination/data/driverPlaceSearchAdapter.ts` (+ test)
- screens/hooks/types/contracts as previously wired

## Tests

- Driver Jest (`src/features/towardsDestination`): **35/35 passed**
- Shared SSOT Node assertions: **passed** (directional, Null Island pickup/dropoff, arrival, usage shape)
- Admin vitest CLI: still blocked by local Deno/vitest package export mismatch — not a TD logic failure

## Clause evidence pointers (local COMPLETE)

- **A store:** migration `set_driver_own_towards_destination`; Driver `activateDestination` RPC args  
- **A dispatch coords:** `auto-dispatch` `destinationMap` + `passesTowardsDestinationFilter`  
- **B qualify:** `shared/towardsDestinationSSOT.ts:towardsDestinationTripQualifies`; SQL twin in migration  
- **B stacked project:** `auto-dispatch` stacked `.filter` using `current_trip_dropoff_lat/lng`  
- **C no trip-id-only reject:** set RPC has no `current_trip_id` gate; stacked pool separate from idle  
- **D arrival 500:** migration columns + `towards_destination_maybe_complete_on_location`  
- **D consume+clear:** `towards_destination_complete_session`  
- **E same-location:** set RPC `destination_already_reached`; `mapTowardsDestinationErrorUi`  
- **F rolling 5:** `towards_destination_usage_snapshot`; activate path does not insert `usage_consumed=true`  
- **Alerts:** `TowardsDestinationScreen` Alert uses `result.title` / `result.message`

## Deployment steps requiring approval (DO NOT EXECUTE)

1. Review migration SQL + Edge diff  
2. Apply migration to prod: `supabase db push` / dashboard (project `thazislrdkjpvvghtvzo`)  
3. Deploy Edge Function `auto-dispatch` (shared import `../../../shared/towardsDestinationSSOT.ts`)  
4. Deploy Admin web (Auto-Dispatch Rules TD card)  
5. Ship Driver app build with error/usage UX (**after** migration — Driver sends `p_postcode`/`p_place_id`)  
6. Regenerate `src/integrations/supabase/types.ts` from post-migrate schema  
7. Smoke: activate near dest → `destination_already_reached`; activate far → no usage drop; enter radius → usage +1; duplicate complete → idempotent; TD driver only progressive trips; stacked+TD uses stacked rules  

## Remaining wiring (not contract gaps; needs deploy or follow-up)

- Migration / Edge / Admin / Driver **not deployed**  
- Full generated types refresh after migrate (incl. `towards_destination_sessions` table)  
- Per-SA Admin form for TD overrides on `dispatch_settings` (global card done; `resolve_config` already reads SA)  
- Optional: backfill historical activate-based `uses_today` (legacy; usage SSOT is sessions)  
- `towards_destination_priority_bonus` still unused by any caller (auto-dispatch is SSOT dispatcher)  
- `offline_cleared` completion reason reserved but unused (offline does not clear TD; intentional unless product changes)  
- Alternate location writers that skip `update_driver_location` / `driver_presence` lat/lng updates would miss arrival completion  

## Third-pass residual list

| item | severity | disposition |
|---|---|---|
| Prod still activate-consume / limit 3 / 3km Edge | deploy lag | Documented; **DO NOT DEPLOY** this pass |
| SQL↔TS Null Island pickup/dropoff asymmetry | contract SSOT | **Fixed** |
| Edge TD used coerced `pickupLat \|\| 0` | matching edge case | **Fixed** |
| Orphan arrival could consume past limit | F edge | **Fixed** |
| Admin types set RPC 3-arg only | wiring | **Fixed** (bridge) |
| Place-search test missing `placeId` | test drift | **Fixed** |
| vitest CLI broken in admin-new | tooling | Unrelated residual |
| Per-SA TD Admin form | follow-up UI | Not A–F |

## DO NOT DEPLOY confirmation

**No migration applied. No Edge deployed. No Admin/Driver release performed. Prod `thazislrdkjpvvghtvzo` untouched.**
