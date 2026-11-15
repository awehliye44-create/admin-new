# Bugs #23 / #24 — pre-deploy verification report

**Date:** 2026-11-15  
**Production pins unchanged:** mig `20270225140000`; Customer OTA `f25365ba`; Driver OTA `9db6b5cc`; `stop-workflow` **v672** live.  
**Deploys paused** until explicit approval. Device timing targets **not** claimed.

---

## Bug #23 — Driver Complete Trip (code-level PASS)

| Check | Result | Evidence |
| --- | --- | --- |
| Completion + `capture_requested` awaited before success | **PASS** | `stop-workflow` awaits trips update with `payment_status: "capture_requested"` then `scheduleEdgeBackground(finalize)` then `respondOk({ payment_capture_deferred })` |
| Sweeper covers isolate death / failed finalize / tip-window | **PASS** | `sweep-revolut-stale-holds` includes `capture_requested`; `capture-expired-tip-windows` includes `capture_requested` + `tip_window_status` open/processing; tip-window TEN queued via `scheduleEdgeBackground` |
| No duplicate capture / settlement | **PASS** | Same `invokeFinalizeTripCapture` SSOT; mutex / capture_requested stamp; no second pipeline |
| `INTERMEDIATE_STOPS_REMAIN` | **PASS** | Still enforced in `complete_trip` before completion write |
| Stacked next-trip handover | **PASS** | Stacked promotion still runs before `respondOk` |
| Payment / wallet rules unchanged | **PASS** | Still `finalize-trip-and-capture` + `postTripEarningNetCanonical` |

**Driver `03a31b9`:** **test-only** (`completeTripCaptureDeferral.execution.test.ts`). **No Driver OTA required** for Bug #23.

**Deploy when approved:** Edge `stop-workflow` from admin tip containing Bug #23 deferral.

---

## Bug #24B — Customer rating + tip (gap closed)

### Clarification (before this verification)

The prior Customer change used **`void submitCustomerTripTipSettling` after `goHome`** — that was **client fire-and-forget**, not backend-owned durable accept. **Not acceptable.**

### After this verification

| Step | Ownership |
| --- | --- |
| Persist rating | Awaited (client → `rider_feedback`) |
| Tip amount stamp + tip-window mutex claim | Awaited durable accept via `submit-customer-trip-tip` |
| Revolut finalize / seal / tip credit | Backend `scheduleEdgeBackground` (`runDeferredTipWindowFinalize`) — same finalize SSOT |
| Home | After durable tip accept (`tip_accepted` / `tip_capture_deferred`) — **not** after Revolut |

Response treats tip as **pending** (`tip_window_status: processing`, `tip_capture_deferred: true`) — **never tip paid** until window seals.

| Scenario | Behaviour |
| --- | --- |
| App closed / killed after Home | Tip intent already claimed; Edge `waitUntil` continues finalize; if isolate dies, claim retained / expiry + stale reclaim GET-first (no blind second POST) |
| Connectivity loss before accept | Tip accept fails; rating already saved; Alert with Continue without tip where refuse codes apply; still Homes |
| Tip retry / ambiguous | Mutex `CLAIM_HELD` / `PROVIDER_UNKNOWN` retains claim; settling retries bounded; never blind second capture |
| Auth decline (bank) | Background release + clear tip; window OPEN; rating kept; never claimed paid on accept |
| Auth cancelled / continue without tip | Client tip=0 settle after refuse dialog |
| Duplicate tip | Mutex + tip stamp CAS |
| Driver 100% tip | Unchanged `DRIVER_TIP_CREDIT` / tip SSOT |
| Pending / success / failure | Accept = pending; sealed closed = success; decline/release = failure (not paid) |

**Deploy when approved:** Edge `submit-customer-trip-tip` + Customer OTA together.

---

## Bug #24A / #24C — stale pending-rating reopen (PASS)

- Submit/Skip write `rider_feedback` **before** `goHome` → `get_customer_pending_trip_rating` excludes that trip.
- `goHome` clears `completedTrip` (Home only reopens Rate when store has a completed trip).
- Post-nav hydrate uses `resolvedTripId` and **skips** the just-resolved trip.

---

## Performance instrumentation

| Stage | Meaning |
| --- | --- |
| `home_screen_visible` | `goHome()` invoked (navigation committed) |
| `home_screen_interactive` | `InteractionManager.runAfterInteractions` — closer to usable Home than router call alone |

**Not** a production-device first-paint guarantee. Device measurement still required before claiming targets.

Driver Complete→Rate telemetry already uses InteractionManager for rate-passenger interactive stages (existing).

### Delayed-finance execution evidence

- Bug #23: Rate-ready before 250ms background finalize (Driver execution test).
- Bug #24B: Home after tip accept while Revolut finalize still running 250ms (Customer execution test).

---

## SHAs / CI (this verification tip)

| Repo | SHA | CI |
| --- | --- | --- |
| admin-new | `b1a947f13c225bbfc356ad05acccee9de498cc42` | [success](https://github.com/awehliye44-create/admin-new/actions/runs/43715911543) |
| onecab-customer-native | `b3f2f3fde2cedc57c4d748d32a871124752c12fc` | [success](https://github.com/awehliye44-create/onecab-customer-native/actions/runs/43715913372) |
| onecab-driver-native | `03a31b9583bd725526949078962add98c4be0a70` | Test-only; no new commit / no OTA |

---

## Recommended deploy order (when approved)

1. Edge `stop-workflow` (Bug #23)  
2. Edge `submit-customer-trip-tip` (Bug #24B)  
3. Customer OTA (Bug #24A/B/C)  
4. **No** Driver OTA for these bugs  
5. Measure production device timings before declaring targets met  

**Migrations:** none.  
**Rollback:** redeploy prior Edge versions; Customer OTA rollback to `f25365ba`.
