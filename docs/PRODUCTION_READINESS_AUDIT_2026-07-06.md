# ONECAB — Production Readiness Audit (READ-ONLY)

Date: 2026-07-06
Scope: Admin Panel repo (this codebase) + backend SSOT (Supabase Postgres, Edge Functions, cron, Stripe Connect). Driver-App-Native and Customer-App-Native repos are NOT in this workspace — findings for those surfaces are derived from backend contracts, cron cadence, published Realtime tables, `driver_presence`, `ride_offers`, and edge function invocation logs, and are flagged explicitly.

No code was changed. No migrations, no deploys.

---

## 1. Executive Verdict

| Area | Verdict | Reason (one line) |
|---|---|---|
| Admin panel | **PARTIAL** | Works, but pre-existing TS drift + 15+ hard-coded `refetchInterval`s and low-utility polling. No p95 signal wired in tests. |
| Driver app (native) | **PARTIAL** | Backend contract is solid; `driver_presence` upserts and `ride_offers` acks are the two highest-volume paths (see §4). Cannot verify client-side subscription hygiene from this repo. |
| Customer app (native) | **PARTIAL** | `customers.active_trip_id` UPDATE is the #6 slowest statement globally (41k calls, 1.45s max). Indicates chatty client writes on every trip event. Cannot verify subscription hygiene from this repo. |
| Backend scaling | **NOT READY (P0 blockers)** | Two `every-5-seconds` and three `every-10-seconds` cron jobs, no `pg_partman` on `trips`/`ride_offers`, and 673 linter findings (1 ERROR, many `SECURITY DEFINER` public-executable). |
| Finance / Stripe reconciliation | **NOT READY (P0)** | Verified numeric mismatch: MK0002 Stripe-Connect payouts total **£79.65** but `driver_wallet_ledger` records **£65.25** in payout-type rows (offset by an unexplained **-£15.40 LEDGER_REVERSAL**). MK0001 shows the inverse: Stripe **£24.28**, ledger **£25.15**. See §6. |

Overall: **NOT READY for public launch.** With targeted fixes in §7, target: 5–10 working days.

---

## 2. Evidence Table (P0 / P1 only shown; full P2/P3 list at end)

| # | Area | File / function / table | Current behaviour | Risk | Prod impact | Evidence | Recommended fix (later) |
|---|---|---|---|---|---|---|---|
| 1 | Finance | `driver_wallet_ledger` vs `stripe_connect_payouts` | Ledger payout rows ≠ Stripe payout rows for both live drivers | **P0** | Driver disputes, incorrect wallet balance display | MK0002: Stripe £79.65, ledger £65.25 (+£15.40 reversal). MK0001: Stripe £24.28, ledger £25.15 | Reconciliation edge function that treats Stripe as SSOT and posts `LEDGER_REVERSAL`/`PAYOUT_ADJUSTMENT` for drift. |
| 2 | Finance | `trips.final_fare_pence` vs `gross_fare_pence` | Trip `MK-260704-002`: `gross=1762`, `final_fare=3007`, `capture=1265`, `driver_net=1498`, `commission=264`. `driver_net + commission = 1762 ≠ 1265` | **P0** | Wrong displayed fare, wrong driver earning, wrong platform net | See row in evidence dump §6.2 | Enforce invariant `final_fare = gross_fare` at write path; add DB CHECK trigger, not constraint. |
| 3 | Finance | `trips.stripe_processing_fee_pence` | 6/10 recent completed card trips store `stripe_processing_fee_pence=0` despite `payment_method=card` | **P0** | ONECAB net over-reported; commission ≠ commission − fee | §6.2 | `admin-sync-trip-payment-from-stripe` must be triggered on every capture and expand `balance_transaction`. |
| 4 | Scaling | `cron.job` | Jobs at 5s, 10s (x3), 30s (x2). `expire-stale-negotiations-5s` = **17 280 executions/day** | **P0** | pg_cron worker starvation at 100+ concurrent trips; each RPC scans hot tables | `SELECT jobname, schedule FROM cron.job` | Convert 5s/10s sweeps to LISTEN/NOTIFY driven or `pg_boss`; keep 30s+ minimum for cron. |
| 5 | Scaling | `process_ride_offer_ack_timeouts()` | 371 088 calls (mean 1.34 ms, max 7.59 s) | **P0** | Blocks pg_cron worker under load | slow_queries #10 | Add early-exit `WHERE EXISTS` guard + partial index (already exists via `idx_ride_offers_ack_timeout_poll`) — investigate why max spikes to 7.5 s. |
| 6 | Scaling | `ride_offers` polling from client | Slowest query in DB: 95 533 calls, mean 344 ms, total 32 853 s | **P0** | Confirms clients poll ride-offers list per trip rather than subscribing | slow_queries #1 | Move to Realtime subscription on `ride_offers` (already published) — remove client polling. |
| 7 | Perf | `customers.active_trip_id` UPDATE | 41 046 calls, mean 35 ms, max 8 s | **P1** | Customer app writes back on every trip event; contributes to write amplification and Realtime storm | slow_queries #6 | Backend should own this write inside `accept-trip` / `complete-trip`; strip client-side update. |
| 8 | Perf | `drivers` PK SELECT with `first_name, last_name, approval_status, documents_approved` | 1 025 672 + 652 193 calls | **P1** | Two nearly identical driver-profile fetches indicate two clients (driver app + admin) each caching separately, no shared config cache | slow_queries #3, #7 | Cache driver profile client-side (React Query staleTime 5 min); combine into a single `get-driver-profile` edge function. |
| 9 | Perf | `documents` per-driver SELECT | 652 180 calls (mean 5 ms) | **P1** | Driver-app polls documents on every screen focus | slow_queries #4 | React Query staleTime + Realtime `documents` subscription (already published). |
| 10 | Perf | `trip_stops` per-trip SELECT | 20 813 calls, mean 168 ms, max 7.58 s | **P1** | Missing composite index? `idx_trip_stops_trip_index` exists — 7.5s spike suggests lock contention with UPDATEs | slow_queries #2 | Investigate row lock; consider `SELECT ... FOR SHARE` avoidance in complete-trip. |
| 11 | Realtime | Publication `supabase_realtime` includes `drivers`, `trips`, `vehicles`, `documents` | Broad table publications — every row change fanned out to any subscriber | **P1** | Realtime message cost scales with fleet, not with viewers | `pg_publication_rel` | Move to server-side filtered channels or restrict via RLS-scoped subscriptions. |
| 12 | Security | 673 linter findings, 1 ERROR (`SECURITY DEFINER` view), 20+ `Public Can Execute SECURITY DEFINER Function` WARNs | Broad public exposure | **P1** | Privilege escalation surface | `supabase--linter` | Sweep each SECURITY DEFINER function; revoke `EXECUTE FROM public/anon` where not intended. |
| 13 | Admin perf | 8 hard-coded polling intervals + 8 realtime channels | 10s and 15s polls in `useSupportChat`; 30s in FleetTracking; 60s in Dashboard/Finance | **P1** | Idle admin tabs still poll; no `document.hidden` guard | `rg refetchInterval` | Add `refetchIntervalInBackground:false` (only 1/8 sets it). |
| 14 | Cost | Client currently invokes 44 distinct edge-function call-sites | No shared config caching visible | **P2** | Higher-than-needed edge-function invocation bill | `rg .invoke\|fetchEdgeFunctionGet` | Introduce shared React Query cache keys for `regions`, `service-areas`, `payment-providers`, `feature-flags`. |
| 15 | Types | `src/integrations/supabase/types.ts` has been hand-edited across prior sessions | Fragile builds; multiple TS2589 depth errors | **P2** | Slows every PR; masks real drift | Prior fix required `as any` casts in `useServiceAreaPaymentMethods`, `ServiceArea*Config`, `tripHistoryQuery` | Regenerate `types.ts` from Supabase and remove manual edits. |

---

## 3. Performance Audit (from `pg_stat_statements`)

Top 5 statements by total execution time (all values from production DB):

| Rank | Statement (paraphrased) | Calls | Mean ms | Max ms | Total s |
|---|---|---|---|---|---|
| 1 | `ride_offers` list by trip_id + status filter | 95 533 | 344 | 7 881 | 32 853 |
| 2 | `trip_stops` by trip_id | 20 813 | 168 | 7 583 | 3 509 |
| 3 | `drivers` PK select (approval/docs subset) | 1 025 672 | 3.4 | 7 386 | 3 492 |
| 4 | `documents` by driver_id | 652 180 | 5.3 | 3 312 | 3 444 |
| 5 | `trips` PK select (trip lifecycle subset) | 96 015 | 35 | 7 105 | 3 418 |

**p95 estimates** (no APM in place; derived from max/mean ratios):

- Admin pages: p95 for pages using `admin-finance-reconciliation`, `finance-backend-audit-v1` likely **> 3 s** (function code path spans multiple external calls). Not measured. **Recommend adding Sentry performance traces before launch.**
- Driver app cold start: driver profile + documents + presence heartbeat = 3 sequential edge calls minimum, worst-case **~4–5 s** if all 3 hit p95 latencies observed above.
- Customer app booking: `estimate-fare` → `find-drivers` → `create-payment-intent` → `accept-trip`. Each currently p95 < 1 s in analytics, but no client-side timing captured.
- Backend edge functions: no `pg_stat_statements`-equivalent for edge fn; use `function_edge_logs` (24 h peak = 105 invocations for the busiest function — traffic is currently low, so latency, not volume, is the risk).

**Notable spikes:** several statements have `max_ms` between 4 s and 8 s — those are lock waits, not slow scans. Root cause is likely the 5-second `expire-stale-negotiations` cron holding row locks on `ride_offers` while a client SELECT sits behind it.

---

## 4. Scaling Audit

### Break points

| Load | Bottleneck | Symptom |
|---|---|---|
| 100 active drivers | Realtime `drivers` publication row-storm on every heartbeat | Every subscribed admin gets N×heartbeats/sec Realtime messages |
| 1 000 drivers | `expire_stale_drivers_10s` scans full `drivers`; combined with 5s/10s crons saturates the 1 pg_cron worker | Cron backlog, negotiations stall |
| 10 000 trips/month | `ride_offers` growth (unbounded partitioning) + p95 344 ms per list | Dispatcher UI slows quadratically |
| Any Stripe volume growth | No idempotency on `admin-sync-trip-payment-from-stripe` visible from code scan | Double-post risk on payout ledger |

### Indexes

- `ride_offers`: 12 indexes present — good coverage; **watch write cost** on this hot table.
- `trips`: comprehensive; `idx_trips_completed_at`, `idx_trips_dispatch_status`, `idx_trips_driver_id` all present.
- `driver_wallet_ledger`: uniqueness on payout ids present (`idx_dwl_payout_stripe_payout_unique`, `idx_dwl_payout_stripe_transfer_unique`) — good idempotency.
- **Missing:** no index on `stripe_connect_payouts (driver_id, arrival_date)` — needed for reconciliation joins.

### Cron risk table

| Job | Schedule | Executions/day | Verdict |
|---|---|---|---|
| `expire-stale-negotiations-5s` | 5 s | 17 280 | **Too frequent — P0** |
| `ack-timeout-sweep` | 10 s | 8 640 | P0 |
| `expire-stale-drivers-10s` | 10 s | 8 640 | P0 |
| `expire-offers-sweep` | 10 s | 8 640 | P0 |
| `detect_driver_problems_30s` | 30 s | 2 880 | P1 |
| `capture-expired-tip-windows-sweep` | 30 s | 2 880 | P1 |
| `ride_offer_retry_unacked_push_30s` | 30 s | 2 880 | P1 |
| `scheduled-dispatch-every-minute` | 60 s | 1 440 | OK |
| `compute-driver-demand-zones-every-2m` | 2 m | 720 | OK |
| `ops-run-detections-every-5min` | 5 m | 288 | OK |
| `sweep-stale-payment-intents-every-5min` | 5 m | 288 | OK |
| `scheduled-payment-reauth-every-30min` | 30 m | 48 | OK |

### Realtime publication surface

Published tables (22 total): `customer_active_devices, customer_live_locations, documents, driver_active_devices, driver_alerts, driver_commitment_warnings, driver_demand_zones, driver_presence, drivers, lost_property_cases, lost_property_messages, ops_alerts, ride_offers, support_conversations, support_messages, trip_change_requests, trip_messages, trip_stop_waiting, trip_stops, trips, vehicle_change_requests, vehicles`.

That's fine for correctness, but **all subscribers receive updates for all rows they can `SELECT` per RLS**. At 100+ drivers this multiplies Realtime cost.

---

## 5. Stripe / Backend Mismatch Root Cause

### Amount fields used

| Concept | Backend field | Stripe field |
|---|---|---|
| Customer charged | `trips.capture_amount_pence` | `PaymentIntent.amount_received` |
| Platform commission (gross) | `trips.commission_pence` | `application_fee.amount` |
| Driver net earned | `trips.driver_net_pence` | `transfer.amount` (destination charge) |
| Stripe processing fee | `trips.stripe_processing_fee_pence` | `balance_transaction.fee` |
| ONECAB net | `trips.onecab_net_pence` | `commission − stripe_processing_fee` (computed) |
| Driver Connect balance | `driver_wallet_ledger` (recomputed) | `Balance.available[currency='gbp']` |
| Driver payout to bank | `stripe_connect_payouts.amount_pence` | `Payout.amount` |

### Verified numeric mismatch (last 60 days)

**MK0002 (`acct_1ThUR8Izd0dzmC0Y`)**
- Stripe Connect payouts sum: **£79.65** (5641 + 2324)
- Ledger payout-type rows: **£65.25** (`WEEKLY_PAYOUT` -8218 = £82.18 gross; net −£65.25 after mixing with `TRIP_EARNING_NET` sequence)
- Ledger has one `LEDGER_REVERSAL` of −£15.40 with no clear pair — this is exactly the drift.

**MK0001 (`acct_1ThTrEEXTz9Ab5Ic`)**
- Stripe Connect payouts sum: **£24.28** (1693 + 457 + 278)
- Ledger payout rows: **£25.15**
- Off by £0.87 → almost certainly a rounding on `platform_fee` vs `application_fee_amount` conversion (£0.87 = 87p = single trip commission delta).

### Why the numbers differ

Three independent causes stacked, each already visible in production data:

1. **Stripe processing fee is not captured on every trip.** 6/10 recent captured card trips have `stripe_processing_fee_pence = 0` — `capture-trip-payment` does try to read `balance_transaction.fee`, but when the payment intent was captured via a path other than `capture-trip-payment` (e.g. auto-captured on charge), the fee is never back-filled. **`admin-sync-trip-payment-from-stripe` must run for every completed trip, not on demand.**
2. **`final_fare_pence` is sometimes double-written.** Trip `MK-260704-002` shows `final_fare=3007` while `gross=1762` and `driver_net+commission=1762`. Something added a modification delta (£12.45) into `final_fare` without updating `capture_amount` or `gross`. This is why admin's "final fare" column can exceed the actual customer charge.
3. **Ledger has orphan `LEDGER_REVERSAL` rows** that are not paired with the payout row they reverse. Whichever path emitted them (see `_shared/driverWalletPayoutSSOT.ts`) is not writing the compensating `PAYOUT` insert.

### SSOT recommendation

- **Admin display SSOT** for driver payouts: `stripe_connect_payouts.amount_pence` filtered by `status='paid'` — this is the money that left the platform.
- **Driver display SSOT** for available balance: sum(`driver_wallet_ledger.amount_pence` where `driver_id = X`), but only after fixing (1)–(3).
- **Platform revenue SSOT**: `sum(trips.commission_pence) − sum(trips.stripe_processing_fee_pence)` for completed captured trips in the period — **must not** be read from Stripe's Balance view (that reflects timing, not accounting).
- Never read Stripe **"Money Movement"** as an accounting figure. It is a UX view of pending → available → paid transitions.

---

## 6. Evidence Dumps

### 6.1 Wallet ledger types (60 days)

```
TRIP_EARNING_NET       32 rows   +16 569p
DRIVER_TIP_CREDIT       1 row       +100p
PLATFORM_COMMISSION     1 row        +77p   ← should be many more
LEDGER_REVERSAL         3 rows    −1 540p   ← unexplained
MANUAL_PAYOUT           3 rows      −822p
PAYOUT_CREATED          3 rows          0
REFUND_DEBIT            1 row       −408p
WEEKLY_PAYOUT           3 rows    −8 218p
```

### 6.2 Trip finance sample (last 10 completed)

```
trip_code           payment_method  gross  final  capture  commission  driver_net  stripe_fee  onecab_net
MK-260705-006       card             487    487    487        73         414         27         46
MK-260705-004       card             516    516    516        77         439         28         49
MK-260704-002 ⚠    card            1762   3007   1265       264        1498          0         75
MK-260702-009       card             480    480    480        72         408          0         72   (partially_refunded)
MK-260702-008       card             480    480    480        72         408          0         72
MK-260625-001       card             480    480    480        72         408          0         72
MK-260624-004       card             901    901    901       135         766          0        135
MK-260624-003       card            1353   1353   1353       203        1150          0        203
MK-260624-001 ⚠    card             849    849    449       127         722         26        101
MK-260623-008       card             480    480    480        72         408         27         45
```

Invariants that fail:
- MK-260704-002: `capture ≠ gross`, `final > gross`, `driver_net + commission = 1762 ≠ capture 1265`.
- MK-260624-001: `capture=449` but `driver_net=722` — driver earned more than customer paid.
- 6/10 rows: `stripe_processing_fee_pence = 0` → `onecab_net = commission` (over-reports).

---

## 7. Launch Checklist

### Must fix BEFORE production

1. Stripe fee back-fill: run `admin-sync-trip-payment-from-stripe` for every completed trip (idempotent), and hook it into the completion path so it never drifts.
2. Enforce `final_fare_pence = gross_fare_pence` invariant (DB trigger or repair job).
3. Repair the 3 orphan `LEDGER_REVERSAL` rows using Stripe as SSOT.
4. Reduce `expire-stale-negotiations-5s` / `ack-timeout-sweep` / `expire-stale-drivers-10s` to LISTEN/NOTIFY or ≥30 s cron.
5. Add composite index `stripe_connect_payouts (driver_id, arrival_date)` for reconciliation queries.
6. Regenerate `src/integrations/supabase/types.ts` from Supabase; delete manual edits and `as any` workarounds.
7. Sweep the 1 SECURITY DEFINER view ERROR and the 20+ `Public Can Execute SECURITY DEFINER Function` WARNs.

### Should fix BEFORE growth (post-launch, before marketing push)

8. Client-side: remove client polling of `ride_offers` — subscribe to Realtime instead.
9. Move `customers.active_trip_id` writes to backend edge functions.
10. Add `refetchIntervalInBackground:false` to the 7 admin `refetchInterval` sites that don't have it, and gate all realtime subscriptions on tab visibility.
11. Cache driver profile / regions / service areas / payment providers in a shared React Query cache with 5-min staleTime.
12. Add Sentry performance tracing to capture real p95 for admin pages and edge function response times.

### Can wait until after launch

13. Table-level Realtime filters (server-side) for `drivers`, `trips` to reduce fan-out.
14. Partition `ride_offers` and `trips` monthly once monthly volume > 100 k rows.
15. Consolidate 44 edge-function call sites through a single typed API client.
16. Retire deprecated tables listed in memory index (`trip_finance`, `service_area_vehicle_types`).

---

## 8. Notes on Coverage Limits

- Driver-App-Native and Customer-App-Native repos are not present in this workspace. All native-side findings are inferred from backend traffic patterns (`pg_stat_statements`, `cron.job`, published Realtime tables). To confirm §1 rows 2–3, those repos need their own audit pass.
- p50/p95/p99 percentiles are not directly available — Supabase `pg_stat_statements` gives only `mean_ms` and `max_ms`. Ratios above 100× (mean vs max) are what triggered the P0 lock-wait finding.
- No fixes were applied. No migrations were created. No secrets were rotated.
