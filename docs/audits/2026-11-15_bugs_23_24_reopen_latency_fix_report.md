# Bugs #23 / #24 reopen — permanent fix release report

**Date:** 2026-11-15  
**Baseline trips:** MK-261115-007, MK-261115-008  
**Status:** Implementation + production Edge + Customer **1.0.5** OTA (1.0.6 OTAs preserved).  
**Device latency targets:** **not claimed** — awaiting personal production retest.

---

## 1. Root causes (from reopen audit)

| Bug | Root cause |
| --- | --- |
| **#23** | Capture deferral worked, but `complete_trip` still blocked ~2.3–2.8s on waiting aggregate, full-trip re-selects, stacked promotion (~431ms), and `respondOk` snapshot refresh. Wall Complete→Rate: **3565ms** / **3198ms**. |
| **#24** | Fixes published only to **1.0.6(23)/(46)**; field devices stayed on **1.0.5(22)/(45)** + OTA `753a282` with blocking Rate→Home (pending hydrate + thanks toast). |

---

## 2. Exact changes

### Bug #23 — `stop-workflow` complete_trip

1. Skip `updateTripTotalWaiting` + fare re-select when no open stop waiting was closed.
2. Parallelise completion write with queued-count + commission + driver region.
3. Fail-closed on completion write (`COMPLETION_WRITE_FAILED`).
4. Compose `fareTrip` in-memory — no post-complete `select(*)`.
5. Stamp `capture_requested` / tip-window unchanged; Revolut finalize still `scheduleEdgeBackground`.
6. Stacked `promote_stacked_trip` moved into `complete_trip_p2` waitUntil (RPC remains atomic + idempotent; payment-confirm path still retries).
7. Clear `drivers.current_trip_id` in P2 when non-stacked.
8. Minimal completion envelope + in-memory stops via `skipSnapshotRefresh: true`.

Lock: `supabase/functions/_shared/completeTripLatencyLock.test.ts`.

### Bug #24 — Customer 1.0.5 compatible OTA

- Source: HEAD `6af35fc` (includes #24 / #24B / #25 + assigned-card/map JS).
- Temporary publish runtime: **iOS `1.0.5(22)`**, **Android `1.0.5(45)`**.
- Live Trip JS soft-gated (`versionCode ≥ 46` / iOS build ≥ 23 + native module) — **excluded from effective behaviour** on 1.0.5 binaries.
- **1.0.6 production OTAs left untouched.**

---

## 3. Before / after backend stage timings

### Before (production MK-261115-007 / 008)

| Trip | Server `complete_trip` | Client wall Complete→Rate | Capture deferred |
| --- | ---: | ---: | --- |
| 007 | **2751 ms** | **3565 ms** | yes |
| 008 | **2265 ms** | **3198 ms** | yes |

Dominant leftover: completion writes, settlement, stacked promotion (007), response snapshot.

### After (non-mutating verification)

- Static locks prove: no post-complete full re-select; stacked promote in P2; skipSnapshotRefresh; capture still deferred.
- **No new paid trips** — measured production wall times after deploy require your retest.
- Expected savings vs 007 profile: ~waiting re-read (when idle) + ~settlement re-select + ~431ms stacked + ~272–574ms snapshot ≈ **~0.8–1.5s** server-side when no open stop waiting.

---

## 4. Regression tests

| Suite | Result |
| --- | --- |
| `completeTripLatencyLock.test.ts` | PASS (5) |
| `completeTripCaptureDeferralLock.test.ts` | PASS (3) |
| Phase2 `complete_trip` notify/capture off-path | PASS |
| MK-261114-006 intermediate stops refuse | PASS |
| Customer `rateTripHome*` / tip durable / Bug #25 decline | PASS (38) |

---

## 5. Production deployment versions

| Surface | Version / SHA | Notes |
| --- | --- | --- |
| `stop-workflow` | **(fill after deploy)** | Latency cut + prior capture deferral |
| `submit-customer-trip-tip` | v92 (unchanged unless redeployed) | Tip durable accept |
| Backend commit | **(fill after commit)** | |
| Customer OTA source | `6af35fc` | |
| Driver | unchanged | No Driver OTA required for #23 |

---

## 6. Customer OTA groups (fill after publish)

### Runtime family 1.0.5 (field devices)

| Platform | Runtime | Group | Update ID | Message |
| --- | --- | --- | --- | --- |
| iOS | 1.0.5(22) | TBD | TBD | 1.0.5 backport #24/#25 |
| Android | 1.0.5(45) | TBD | TBD | 1.0.5 backport #24/#25 |

### Runtime family 1.0.6 (preserved)

| Platform | Runtime | Latest tip (pre-this-task) |
| --- | --- | --- |
| iOS | 1.0.6(23) | Bug #25 `6af35fc` group `b46db1d5…` |
| Android | 1.0.6(46) | Bug #25 `6af35fc` group `5b79533e…` |

---

## 7. Excluded from 1.0.5 effective release

| Item | Why |
| --- | --- |
| Live Trip Lock Screen / ActivityKit / Android ongoing | Requires native 1.0.6 (vc46 / iOS 23). Soft-gated no-op on 1.0.5. |
| Native module upgrades | No new native deps; no store rebuild in this task. |

---

## 8. Rollback

**Edge:** redeploy prior `stop-workflow` source at `83c7fc3a` / v673 capture-deferral tip (`ceceb1f1`…`20a9d2ea` lineage) without latency cut.  
**Customer 1.0.5 OTA:** publish previous 1.0.5 tip (`753a282`) or Expo rollback to prior group for `1.0.5(22)` / `1.0.5(45)`.  
**Do not** roll 1.0.6 channel when reverting 1.0.5.

---

## 9. Device adoption

Fill after publish from `customer_active_devices` / `driver_active_devices` (`loaded_update_id`, `runtime_version`). Pre-fix: Customer still on `753a282` @ 1.0.5; Driver on `f0f7d84` @ 1.0.6(64).
