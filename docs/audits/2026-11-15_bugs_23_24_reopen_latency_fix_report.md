# Bugs #23 / #24 reopen — permanent fix release report

**Date:** 2026-11-15  
**Baseline trips:** MK-261115-007, MK-261115-008  
**Status:** **SHIPPED** — production Edge + Customer **1.0.5** OTA (1.0.6 OTAs preserved).  
**Device latency targets:** **not claimed** — await personal production retest after OTA adoption.

---

## 1. Root causes (reopen audit)

| Bug | Root cause |
| --- | --- |
| **#23** | Capture deferral worked (`payment_capture_deferred: true`), but `complete_trip` still blocked **2.3–2.8s** server-side on waiting aggregate, full-trip re-selects, stacked promotion (~431ms on 007), and `respondOk` snapshot refresh. Measured wall Complete→Rate: **3565ms** (007) / **3198ms** (008). |
| **#24** | Fixes published only to **1.0.6(23)/(46)**; field devices stayed on **1.0.5(22)/(45)** + OTA `753a282` with blocking Rate→Home (pending hydrate + 2.2s thanks toast). |

---

## 2. Exact changes

### Bug #23 — `stop-workflow` (`f896f4ec`)

1. Skip `updateTripTotalWaiting` + fare re-select when no open stop waiting was closed.
2. Parallelise completion write with queued-count + commission + driver region; fail-closed (`COMPLETION_WRITE_FAILED`).
3. Compose `fareTrip` in-memory — no post-complete `select(*)`.
4. Preserve deferred Revolut finalize + `capture_requested` / tip-window stamps (unchanged SSOT).
5. Move atomic/idempotent `promote_stacked_trip` into `complete_trip_p2` waitUntil (payment-confirm path still retries).
6. Clear `drivers.current_trip_id` in P2 when non-stacked.
7. Minimal completion envelope + in-memory stops via `skipSnapshotRefresh: true`.

Lock: `supabase/functions/_shared/completeTripLatencyLock.test.ts`.

### Bug #24 — Customer 1.0.5 compatible OTA

- Source JS: **`6af35fc`** (Bugs #24 / #24B / #25 + assigned-card/map JS).
- Published with temporary runtime constants **1.0.5(22)** / **1.0.5(45)** (worktree; master unchanged at 1.0.6).
- Live Trip soft-gated off on these binaries (`vc≥46` / iOS build `≥23` + native module).

---

## 3. Before / after backend stage timings

### Before (production)

| Trip | Server `complete_trip` | Client wall Complete→Rate | Notes |
| --- | ---: | ---: | --- |
| MK-261115-007 | **2751 ms** | **3565 ms** | stacked promotion ~431ms; snapshot ~272ms |
| MK-261115-008 | **2265 ms** | **3198 ms** | no stacked; snapshot ~574ms |

Capture started **after** HTTP return on both trips.

### After (non-mutating verification)

- Locks prove: no post-complete full re-select; stacked promote in P2; skipSnapshotRefresh; capture still deferred; completion write fail-closed.
- **No new paid trips in this task** — do not treat targets as device-passed until you retest.
- Expected server savings vs 007 profile when no open stop waiting: roughly waiting re-read + settlement re-select + stacked (~431ms) + snapshot (~0.3–0.6s).

---

## 4. Regression tests

| Suite | Result |
| --- | --- |
| `completeTripLatencyLock.test.ts` | **PASS** (5) |
| `completeTripCaptureDeferralLock.test.ts` | **PASS** (3) |
| Phase2 `complete_trip` capture/notify off-path | **PASS** |
| MK-261114-006 intermediate stops refuse | **PASS** |
| Customer Rate→Home / tip durable / Bug #25 | **PASS** (38) |

---

## 5. Production deployment versions

| Surface | Version / SHA | Notes |
| --- | --- | --- |
| Backend commit | `f896f4ec25a5b1bb1f3cd6279009610b6b287c92` | Pushed `main` |
| `stop-workflow` | **v674** | Deployed 2026-11-15 ~15:20Z |
| `submit-customer-trip-tip` | **v92** | Unchanged |
| Customer OTA source | `6af35fcee885789bd8f4c90a57354dbcf90565b7` | |
| Driver | unchanged | No Driver OTA for #23 |

---

## 6. Customer OTA groups

### Runtime family 1.0.5 (field devices) — **NEW**

| Platform | Runtime | Group | Update ID |
| --- | --- | --- | --- |
| iOS | **1.0.5(22)** | `3a88cab7-037e-41f6-b42a-6fdbc6100f1a` | `01a1dfcc-ff0b-7e22-82ea-9dfaf4f33db6` |
| Android | **1.0.5(45)** | `e83c6071-0693-4c81-92b0-738b4a4b234f` | `01a1dfcc-ff0b-7e87-b039-9cf2f2856474` |

Message: `1.0.5 backport: Bugs #24/#24B/#25 + assigned-card/map JS (Live Trip soft-gated; 6af35fc)`

Dashboards:  
- iOS: https://expo.dev/accounts/awehliye44/projects/onecab-customer-native/updates/3a88cab7-037e-41f6-b42a-6fdbc6100f1a  
- Android: https://expo.dev/accounts/awehliye44/projects/onecab-customer-native/updates/e83c6071-0693-4c81-92b0-738b4a4b234f  

### Runtime family 1.0.6 — **preserved**

| Platform | Runtime | Group (Bug #25 tip) |
| --- | --- | --- |
| iOS | 1.0.6(23) | `b46db1d5-ea56-455c-b15b-1bab9c73b176` |
| Android | 1.0.6(46) | `5b79533e-b184-4ed1-bc97-f0e34a223c40` |

---

## 7. Excluded from 1.0.5 effective behaviour

| Item | Why |
| --- | --- |
| Live Trip Lock Screen / ActivityKit / Android ongoing | Requires native 1.0.6 (vc46 / iOS 23). Soft-gated no-op on 1.0.5. |
| Native module / store rebuilds | Out of scope; no EAS binary / store submission. |

---

## 8. Rollback

**Edge:** redeploy `stop-workflow` from pre-latency tip (`ceceb1f1`…`20a9d2ea` / prior **v673** capture-deferral).  
**Customer 1.0.5 OTA:** republish prior 1.0.5 tip (`753a282`) or Expo rollback for groups `3a88cab7…` / `e83c6071…` only.  
**Do not** alter 1.0.6 channel when reverting 1.0.5.

---

## 9. Device adoption (at ship time)

| Device | Runtime | Loaded update | Status |
| --- | --- | --- | --- |
| Customer Android (008) | 1.0.5(45) | still `01a1d6c3-dab2…` (`753a282`) | **not yet adopted** new 1.0.5 OTA |
| Customer iOS (007) | 1.0.5(22) | still `01a1d6c3-ee73…` (`753a282`) | **not yet adopted** |
| Driver Android | 1.0.6(64) | `01a1dac1…` (`f0f7d84`) | N/A for #24; #23 is Edge |

Safe OTA apply preserved (no forced offline / no mid-trip reload). Adoption expected on next cold start / safe window with `checkAutomatically: ON_LOAD`.

---

## 10. Retest checklist (your device)

1. Confirm Customer `loaded_update_id` = `01a1dfcc-ff0b-7e22…` (iOS) or `01a1dfcc-ff0b-7e87…` (Android).  
2. Confirm `stop-workflow` **v674** still live.  
3. New production trips only — measure Complete→Rate and Rate→Home; do not mutate historical trips.
