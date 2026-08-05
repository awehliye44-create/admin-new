# Towards Destination — FINAL PRODUCTION DEPLOYMENT GATE

**Date:** 2026-08-01  
**Pass reference:** `69b49818-bfb6-43d1-aeba-f13a745e55e8` (third Towards Destination gap pass — local A–F COMPLETE; prod still old)  
**Prior report:** `admin-new/docs/TOWARDS_DESTINATION_SSOT_AUDIT_IMPLEMENTATION_REPORT.md`  
**Prod project:** `thazislrdkjpvvghtvzo` (ONECAB ltd, `eu-central-1`)  
**Gate status:** READY FOR HUMAN APPROVAL — **NOT EXECUTED**

---

## Verdict

Local contract A–F is COMPLETE. Production remains on the **old** activate-consume / limit-3 / 3 km radius path. This gate inventories exact artifacts, SHAs, evidence, order, rollback, and smoke steps. **No migration applied. No Edge deployed. No Admin/Driver release performed.**

---

## 1. Exact migration filename(s)

| # | File | Exists |
|---|---|---|
| 1 | `supabase/migrations/20260909120000_towards_destination_ssot_rolling_completions.sql` | **YES** (`admin-new`) |

**Follow-ups:** None. No later `*towards*` / `*rolling_complet*` migrations exist after this file. This single migration is the full DB release unit.

Absolute path:

`/Users/admin/admin-new/supabase/migrations/20260909120000_towards_destination_ssot_rolling_completions.sql`

---

## 2. Exact Edge Function(s), RPCs, SQL functions, views and triggers being changed

### Edge Functions (deploy)

| Artifact | Change |
|---|---|
| `supabase/functions/auto-dispatch/index.ts` | Replace hardcoded `DESTINATION_MATCH_RADIUS_METERS = 3000` dropoff-near-dest filter with directional `towardsDestinationTripQualifies` (idle + stacked). Requires shared import. |
| `shared/towardsDestinationSSOT.ts` | Bundled with Edge deploy (imported as `../../../shared/towardsDestinationSSOT.ts`). **Not** a separate Edge slug. |

No other Edge Function under `supabase/functions/` imports `towardsDestinationSSOT`.

### Tables / columns

| Object | Change |
|---|---|
| `public.global_dispatch_settings` | ADD `towards_destination_arrival_radius_meters` (default 500), `towards_destination_min_progress_meters` (100), `towards_destination_max_pickup_detour_meters` (8000); UPDATE live rows → limit **5**, matching tolerance **200**; DEFAULT limit → 5 |
| `public.dispatch_settings` | Same new columns; align SA rows limit/tolerance where distinct |
| `public.driver_settings` | ADD `towards_destination_postcode`, `towards_destination_place_id`, `towards_destination_session_id` |
| `public.towards_destination_sessions` | **CREATE** table + unique active-per-driver index + usage index + RLS policy `towards_destination_sessions_select_own` |

### SQL functions / RPCs (CREATE OR REPLACE unless noted)

| Name | Role |
|---|---|
| `towards_destination_resolve_config` | SA-aware config (limit, duration, tolerance, weight, arrival, min_progress, max_detour) |
| `towards_destination_usage_snapshot` | Rolling 24h completions-only usage JSON |
| `towards_destination_trip_qualifies` | SQL twin of directional match |
| `towards_destination_priority_bonus` | Priority helper (unchanged callers; auto-dispatch remains SSOT dispatcher) |
| `towards_destination_clear_filter` | Clear active filter columns on `driver_settings` |
| `towards_destination_complete_session` | Idempotent complete/cancel; consume **only** when `reason = destination_reached` |
| `towards_destination_maybe_complete_on_location` | Arrival / expiry / orphan-filter handling |
| `towards_destination_presence_arrival_trigger` | Trigger function for presence lat/lng |
| `update_driver_location` | Hooks arrival check after location write |
| `get_driver_own_towards_destination` | Driver read API + usage shape |
| `set_driver_own_towards_destination` | Activate (5-arg with optional postcode/place_id); **DROP** legacy 3-arg overload |
| `clear_driver_own_towards_destination` | Manual cancel → `manual_clear` (no consume) |

### Triggers

| Trigger | Action |
|---|---|
| `trg_td_arrival_on_presence` ON `public.driver_presence` | **CREATE** (AFTER INSERT OR UPDATE OF lat, lng) |
| `reset_destination_uses_trigger` ON `public.driver_settings` | **DROP** (legacy calendar-day reset) |

### Views

**None** created or altered by this migration.

### Admin UI (publish, not DB)

| Path | Change |
|---|---|
| `src/pages/AutoDispatchRules.tsx` | TD card defaults: limit 5, tolerance 200, min progress 100, max detour 8000, arrival 500 |
| `src/integrations/supabase/types.ts` | Partial RPC/column bridge (full regen **after** migrate) |

### Driver app (ship)

See § Driver artifacts below.

---

## 3. SHA-256 for every migration / deployable backend artifact

Computed 2026-08-01 via `shasum -a 256` (local workspace). **Do not invent alternate digests.**

| Path | SHA-256 |
|---|---|
| `supabase/migrations/20260909120000_towards_destination_ssot_rolling_completions.sql` | `1ceff10153ee4b3012b645c4807d598cfb21c523fc4b8851169ad618d7ca8831` |
| `supabase/functions/auto-dispatch/index.ts` | `b7c18bf66d3029aec1cc07c36fcd7ad3add2323d7a4fd26457c3e110e70f737d` |
| `shared/towardsDestinationSSOT.ts` | `6b161d7eef3779e6e7fce946d00633749a986191910e5a8c7c4b88f3f8b6bc0e` |

**Deployable set (Edge + shared import that ships with it):** both `auto-dispatch/index.ts` and `shared/towardsDestinationSSOT.ts` above. The function directory contains only `index.ts`; the shared module is resolved at bundle time from repo root.

**Reference — currently deployed prod Edge body (read-only download, not a release artifact):**

| Artifact | SHA-256 | Notes |
|---|---|---|
| Management API `GET .../functions/auto-dispatch/body` (eszip, 667 573 bytes) | `897c185cbd9d246c94e7818128e04a7ed88bbcab22acbee05c5479633c84b970` | Prod `auto-dispatch` **v522**; contains `DESTINATION_MATCH_RADIUS_METERS = 3000`; **no** `towardsDestinationTripQualifies` |

Optional Admin UI hash (not Edge):

| Path | SHA-256 |
|---|---|
| `src/pages/AutoDispatchRules.tsx` | `13374e1010bfd668027d3169dc0024f23fb5480968dd4708edc6e51d28613229` |

---

## 4. Confirmation: production currently remains on limit 3 and old 3 km path

**Confirmed 2026-08-01 via Management API SQL + Edge body (read-only).**

| Check | Live prod evidence |
|---|---|
| GDS daily limit | `towards_destination_daily_limit = 3` |
| Matching tolerance | `towards_destination_matching_tolerance_meters = 3000` |
| `towards_destination_resolve_config(null)` | `{"daily_limit":3,"matching_tolerance_meters":3000,...}` |
| Arrival / min_progress / max_detour columns | **Absent** (query on those columns → `42703`) |
| `towards_destination_sessions` | `to_regclass(...) = null` |
| New TD SQL helpers | Only legacy: `towards_destination_business_date`, `towards_destination_priority_bonus`, `towards_destination_resolve_config` — **missing** `trip_qualifies`, `usage_snapshot`, `complete_session`, `maybe_complete_on_location` |
| `set_driver_own_towards_destination` | Args: `p_address text, p_lat double precision, p_lng double precision` only; `prosrc` contains `v_uses := v_uses + 1` (**activate consumes**); **no** `destination_already_reached`; **no** sessions table |
| Edge `auto-dispatch` | **v522** ACTIVE; body has `const DESTINATION_MATCH_RADIUS_METERS = 3000; // 3km radius for matching`; `towardsDestinationTripQualifies` **NOT_FOUND** |

---

## 5. Confirmation: release changes limit to 5 successfully completed sessions in rolling 24h

| Source | Citation |
|---|---|
| Migration UPDATE + DEFAULT | Sets `towards_destination_daily_limit = 5` on GDS + SA; `ALTER COLUMN ... SET DEFAULT 5`; comment: *“Max successful … completions … rolling 24-hour window. Activate/cancel do not consume.”* (`20260909120000_...sql` lines 24–48) |
| Usage SSOT | `towards_destination_usage_snapshot` counts only `status=completed` AND `completion_reason='destination_reached'` AND `usage_consumed=true` AND `completed_at > now() - interval '24 hours'`; default limit coalesce **5** |
| Admin defaults | `AutoDispatchRules.tsx` `towardsDestinationDailyLimit: 5` (defaultSettings ~line 166; UI clamp 1–20, fallback 5) |
| Shared TS | `buildTowardsDestinationUsageSnapshot` / `TOWARDS_DESTINATION_WINDOW_TYPE = "rolling_24_hours"` |

---

## 6. Confirmation: selecting / activating / cancelling / offline / system termination does NOT consume a use

| Action | Mechanism | Consumes? |
|---|---|---|
| **Activate / select** | `set_driver_own_towards_destination` inserts session with `usage_consumed = false`; comment *“Refresh usage (unchanged by activate)”* | **No** |
| **Replace prior active** | `complete_session(prev, 'replaced')` → `v_consume := (p_reason = 'destination_reached')` → false | **No** |
| **Cancel / clear** | `clear_driver_own_towards_destination` → `complete_session(..., 'manual_clear')` | **No** |
| **Expiry (system)** | `maybe_complete_on_location` / get path → `complete_session(..., 'expired')` | **No** |
| **Offline** | Reason `offline_cleared` is **reserved but unused**; offline does **not** clear TD and does **not** consume (intentional per audit report) | **No** |
| **Only consume** | `complete_session(..., 'destination_reached')` sets `usage_consumed = true` | **Yes (exactly once; see §7)** |

---

## 7. Confirmation: destination completion is idempotent and consumes exactly one use

| Behaviour | Citation |
|---|---|
| Consume gate | `v_consume boolean := (p_reason = 'destination_reached')` in `towards_destination_complete_session` |
| Idempotent re-entry | If already `status=completed` AND `completion_reason=destination_reached` AND `usage_consumed=true` → return `{ok:true, idempotent:true, usage:...}` **without** second consume |
| Active-row update | `UPDATE ... WHERE id = p_session_id AND status = 'active'` (single transition) |
| Usage count | Snapshot counts completed+consumed rows once each; duplicate complete returns same usage |

---

## 8. Confirmation: matching uses approved coordinate/directional progress + configurable detour

| Layer | Citation |
|---|---|
| Shared SSOT | `towardsDestinationTripQualifies`: qualifies when `dropoffToDest < driverToDest + tolerance` AND `progress >= minProgress`; rejects if `maxPickupDetourMeters > 0` and `driverToPickup > maxDetour`; coords-only (rejects Null Island on driver/pickup/dropoff/dest) |
| SQL twin | `towards_destination_trip_qualifies(...)` same rules; defaults tolerance 200 / min progress 100 / max detour 8000 |
| auto-dispatch | Imports SSOT; builds `tdMatchConfig` from `towards_destination_resolve_config` (fallback dispatch_settings); `passesTowardsDestinationFilter` requires finite pickup+dropoff; used on **idle** and **stacked** pools |

---

## 9. Confirmation: compatible stacked rides remain supported

| Evidence | Detail |
|---|---|
| Idle vs stacked pools | Idle hard-gate keeps `current_trip_id` null; stacked pool remains separate (busy drivers) with stacked rules (`max_stacked_rides`, search radius, detour minutes, offer window) |
| TD filter on stacked | `filteredStackedDrivers` applies `passesTowardsDestinationFilter` projecting from `current_trip_dropoff_lat/lng` (active dropoff as effective position) |
| Set RPC | No `current_trip_id` reject — TD may stay active while on trip |
| No separate TD stacking policy | Same stacked rules + TD directional filter |

---

## 10. Confirmation: same-location activation rejected without consuming usage

| Evidence | Detail |
|---|---|
| `set_driver_own_towards_destination` | Haversine(driver → dest) ≤ arrival radius → return `error: destination_already_reached` with UK `title`/`message` **before** session insert |
| No session / no usage | Early return; no `INSERT` into `towards_destination_sessions`; usage snapshot returned unchanged |
| Driver UX | `mapTowardsDestinationErrorUi('destination_already_reached')` → title *Choose another destination* |

---

## 11. Confirmation: raw errors like `daily_limit_reached` mapped to friendly Driver messages

| File | Behaviour |
|---|---|
| `onecab-driver-native/src/features/towardsDestination/lib/mapTowardsDestinationError.ts` | Maps `daily_limit_reached` → rolling 24h UK copy (limit-aware); `destination_already_reached` → approved title/message; snake_case codes never shown raw (default fallback) |
| Tests | `mapTowardsDestinationError.test.ts` asserts message is not `'daily_limit_reached'` |
| Screen | `TowardsDestinationScreen` / adapter use `mapTowardsDestinationErrorUi` → Alert title/message |

---

## 12. Production dependency / order check

Execute **only after explicit go-ahead**. Order is mandatory:

1. **Preflight:** Confirm PITR/backup posture (§13); optional manual snapshot; verify SHAs match this gate.
2. **Database migration first:** Apply `20260909120000_towards_destination_ssot_rolling_completions.sql` to `thazislrdkjpvvghtvzo` (`supabase db push` / Dashboard SQL).  
   - Creates sessions table, new columns, RPCs, trigger; flips GDS limit 3→5 and tolerance 3000→200.
3. **Edge Function second:** Deploy `auto-dispatch` **with** bundled `shared/towardsDestinationSSOT.ts` (must be after migration so `towards_destination_resolve_config` returns new keys).
4. **Admin UI third:** Publish Lovable / Admin web so Auto-Dispatch Rules TD card matches new columns (limit 5, arrival, detour, etc.).
5. **Driver app fourth:** Ship JS build with error mapper + activate args (`p_postcode` / `p_place_id`). Prefer **after** migration so 5-arg RPC exists.
6. **Types regen (follow-up):** Regenerate `src/integrations/supabase/types.ts` from post-migrate schema.
7. **Smoke (§16)** before declaring go-live complete.

**Do not** deploy Edge before migration (Edge calls `towards_destination_resolve_config` for arrival/detour/min_progress keys).  
**Do not** ship Driver expecting friendly same-location / sessions usage against old 3-arg activate-consume RPC without migration.

---

## 13. Database backup / PITR status

**Read-only Management API** `GET /v1/projects/thazislrdkjpvvghtvzo/database/backups` (2026-08-01):

| Field | Value |
|---|---|
| `pitr_enabled` | **false** |
| `walg_enabled` | **true** |
| Physical backups | Present / COMPLETED (latest sampled: `2026-08-01T00:47:54.709Z`, id `1259851913`; prior daily backups through 2026-07-25+) |

**Implications:**

- Point-in-time restore is **not** enabled — recovery is to physical backup points, not arbitrary timestamps.
- **Recommend:** Before apply, take a Dashboard **manual backup / snapshot** (or confirm latest nightly physical backup is fresh and retention is acceptable). Re-verify via Dashboard → Project Settings → Database → Backups, or CLI/API as above.

---

## 14. Rollback plan

| Layer | Reverse steps | Risk notes |
|---|---|---|
| **Edge** | Redeploy previous `auto-dispatch` (**v522** body SHA `897c185c…` / prior git tag). Matching returns to hardcoded 3 km immediately. | Safe independently; does not drop tables. |
| **Admin** | Republish prior Lovable build / revert AutoDispatchRules TD card. | UI-only. |
| **Driver** | Roll back OTA/store build to pre-TD-SSOT JS. Old client still works with 3-arg set RPC if DB also rolled back; against new DB, prefer keeping new Driver if migration stays. | Coordinate with DB state. |
| **Database** | **No automated down migration ships with this file.** Rollback options: (a) restore from physical backup taken pre-apply; (b) carefully hand-revert RPCs to prior definitions **and** decide fate of `towards_destination_sessions`. | **High risk:** Dropping `towards_destination_sessions` loses completion history / usage SSOT. Leaving the table while reverting `set_*` to activate-consume creates dual counters. Prefer **full backup restore** over partial DROP. |
| **Trigger** | Restoring backup restores `reset_destination_uses_trigger` if it existed; new `trg_td_arrival_on_presence` removed on restore. | Arrival completion stops if trigger removed without replacement. |
| **Config values** | Migration sets limit 5 / tolerance 200; restore or manual UPDATE needed to revert to 3 / 3000. | |

**Recommended rollback order if post-deploy failure:** Edge → Driver (if broken UX) → Admin → DB restore (last resort).

---

## 15. Exact tests passed

### Driver Jest (rerun 2026-08-01)

```bash
cd /Users/admin/ONECAB/onecab-driver-native
npx jest src/features/towardsDestination --colors=false
```

**Result:** `Test Suites: 5 passed, 5 total` · **`Tests: 35 passed, 35 total`** · exit 0

Suites: `placeSearchRequestGate`, `normalisePlaceSearchQuery`, `driverPlaceSearchAdapter`, `mapTowardsDestinationError`, `towardsDestinationAdapter`.

### Shared SSOT (vitest CLI blocked in admin-new; Deno parity rerun 2026-08-01)

Admin `vitest` remains broken (`ERR_PACKAGE_PATH_NOT_EXPORTED` `vite/module-runner` via Deno-managed vitest). Mirrored all **11** cases in `shared/__tests__/towardsDestinationSSOT.test.ts` via Deno:

```bash
deno run --allow-read /tmp/td_ssot_vitest_parity.ts
```

**Result:** `SSOT_VITEST_PARITY asserts_passed=19 asserts_failed=0` (covers directional qualify/reject, Null Island pickup+dropoff, arrival, usage shape, next_available_at, idempotent count).

---

## 16. Exact production smoke-test plan (after go-live)

1. **Schema probe:** `towards_destination_sessions` exists; GDS `towards_destination_daily_limit = 5`; columns arrival/min_progress/max_detour present; tolerance = 200 (unless Admin overrode).
2. **Edge probe:** Deployed `auto-dispatch` body contains `towardsDestinationTripQualifies` and does **not** contain `DESTINATION_MATCH_RADIUS_METERS = 3000`.
3. **Same-location:** Driver near chosen dest → Alert *Choose another destination*; usage `completed_last_24h` unchanged; no new session row with `usage_consumed=true`.
4. **Activate far:** Session created `usage_consumed=false`; remaining unchanged; filter active with lat/lng/address/postcode/place_id as sent.
5. **Cancel:** `clear_driver_own_towards_destination` → session `manual_clear` / cancelled; usage unchanged.
6. **Arrival consume:** Drive/simulate into arrival radius → one `destination_reached` with `usage_consumed=true`; remaining −1; filter cleared; online driver re-enters normal pool.
7. **Idempotent complete:** Re-fire arrival/complete → `idempotent: true`; usage unchanged.
8. **Limit:** After 5 rolling completions → activate returns friendly limit message (not raw `daily_limit_reached`).
9. **Matching:** TD-active driver receives only trips with directional progress (+ detour gate); wrong-direction trip skipped in Edge logs.
10. **Stacked + TD:** On-trip TD driver still eligible for stacked offer when stacked rules + TD filter pass (project from active dropoff).
11. **Admin:** Auto-Dispatch Rules shows/edits limit 5 + arrival/detour/progress fields; save persists to GDS.

---

## Driver app artifacts to ship

**TD feature paths (JS/TS — primary ship set):**

- `src/features/towardsDestination/lib/mapTowardsDestinationError.ts` (+ test)
- `src/features/towardsDestination/data/towardsDestinationAdapter.ts` (+ test)
- `src/features/towardsDestination/data/driverPlaceSearchAdapter.ts` (+ test)
- `src/features/towardsDestination/screens/TowardsDestinationScreen.tsx`
- `src/features/towardsDestination/screens/DestinationSearchScreen.tsx`
- `src/features/towardsDestination/hooks/useTowardsDestination.ts`
- `src/features/towardsDestination/hooks/useDriverPlaceSearch.ts`
- `src/features/towardsDestination/types.ts`
- `src/features/towardsDestination/fixtures/towardsDestinationFixtures.ts`
- Routes: `src/app/towards-destination/*`
- Related home entry: `HomeTopControls` / `DriverHomeScreen` (entry affordances)

**Native rebuild needed for TD-only?** **No** — Towards Destination changes are JS/TS + Supabase RPC contracts. An OTA / JS bundle update is sufficient for TD. (Unrelated native work may exist on the Driver branch; do not conflate with this gate.)

Key local SHAs (Driver):

| Path | SHA-256 |
|---|---|
| `mapTowardsDestinationError.ts` | `4d1281587abd4ebadc09e524e14fda56c5827057c2800ba4baa76fdb94747830` |
| `towardsDestinationAdapter.ts` | `0715403e65b781366f5bef373beaf68b37685067901881755ec2cbc1b9918012` |
| `driverPlaceSearchAdapter.ts` | `eef53d70a888cc77941676a0d5f0e56a7ab31e0b78e2339a752f8857cc3f7799` |

---

## Admin UI publish (Lovable)

Admin is a Lovable project (`admin-new/README.md`: Share → **Publish**). After migration + Edge:

1. Ensure `AutoDispatchRules.tsx` TD card is on the branch Lovable builds from.
2. Publish via Lovable (or equivalent production Admin host).
3. Confirm live Admin shows daily limit **5** and new arrival / progress / detour fields.
4. Regenerate Supabase types after migrate (bridge already partial).

---

## Gate checklist (sign-off)

| # | Item | Status |
|---|---|---|
| 1 | Migration file exists & SHA recorded | DONE |
| 2 | Edge / RPC / trigger inventory complete | DONE |
| 3 | Artifact SHAs computed (not invented) | DONE |
| 4 | Prod still limit 3 / 3 km (live evidence) | CONFIRMED |
| 5 | Release → 5 rolling completions | CONFIRMED (local) |
| 6 | Non-arrival actions do not consume | CONFIRMED (local) |
| 7 | Idempotent single consume on arrival | CONFIRMED (local) |
| 8 | Directional + detour matching | CONFIRMED (local) |
| 9 | Stacked + TD supported | CONFIRMED (local) |
| 10 | Same-location reject, no usage | CONFIRMED (local) |
| 11 | Friendly Driver error mapping | CONFIRMED (local + tests) |
| 12 | Deploy order documented | DONE |
| 13 | Backup/PITR checked | PITR off; WALG physical backups on — snapshot recommended |
| 14 | Rollback plan documented | DONE |
| 15 | Tests rerun / recorded | Driver 35/35; SSOT Deno parity 11 cases |
| 16 | Smoke plan numbered | DONE |

---

## DO NOT DEPLOY

**This document is a gate only.**

- **DO NOT** apply `20260909120000_towards_destination_ssot_rolling_completions.sql` to production.
- **DO NOT** deploy Edge Function `auto-dispatch`.
- **DO NOT** publish Admin / Lovable for this change set as part of this gate.
- **DO NOT** ship the Driver release as part of this gate.
- Prod project `thazislrdkjpvvghtvzo` was inspected **read-only** and left **untouched**.

Await explicit human approval before any production action.
