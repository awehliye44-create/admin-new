# Bugs #23 / #24 — Trip completion & rating performance report

**Date:** 2026-11-15  
**Production baseline preserved:** migration head `20270225140000`; Customer `f25365ba`; Driver `9db6b5cc`; Edge `stop-workflow` v672 / `scheduled-ride-action` v591 / `scheduled-dispatch` v653 / `admin-scheduled-ride-action` v11 / `send-driver-notification` v600.  
**This change set is code+CI only — production Edge/OTA/native/store remain paused until explicit approval.**

**Do not claim device targets met** — timings below are isolated/code-level evidence only.

---

## Root causes

### Bug #23 — Driver Complete Trip → Rate your passenger (~6–10s)

| Rank | Cause | Evidence |
| --- | --- | --- |
| 1 | **Awaited `finalize-trip-and-capture` (Revolut)** on the Complete HTTP response for non-tip-window trips | `stop-workflow` `complete_trip` previously `await invokeFinalizeTripCapture` before `respondOk` |
| 2 | **Awaited tip-window TEN wallet post** even when capture was deferred | `await postTripEarningNetCanonical` on tip-window branch |
| 3 | Sequential pre-settlement DB reads (secondary) | Multiple trip/area reads before response |
| — | Client path already fast | Seeds Rate after Edge response; Rate→Home was already non-blocking |

Payment capture was **not** assumed blindly — tip-window trips already deferred Revolut, yet still felt slow due to TEN await + remaining sequential work. Immediate-capture trips paid the full Revolut cost on the Rate path.

### Bug #24A — Customer Submit rating → Home

| Rank | Cause |
| --- | --- |
| 1 | **Fixed 2.2s `RatingThanksToast` gated Home** (`RATING_THANKS_AUTO_DISMISS_MS`) |
| 2 | Extra awaited `fetchCustomerPendingTripRating` after rating write |
| 3 | Pre-submit awaited tip eligibility refresh |

### Bug #24B — Submit rating + tip → Home

| Rank | Cause |
| --- | --- |
| 1 | **Awaited full tip settle** (Edge → finalize → Revolut capture → wallet) **before** rating write |
| 2 | Same toast gate as 24A |
| 3 | Settling retries with 1.2s / 2.4s / 3.6s sleeps |

### Bug #24C — Skip → Home

| Rank | Cause |
| --- | --- |
| 1 | Awaited `fetchCustomerPendingTripRating` before `goHome` |
| 2 | Tip close already fire-and-forget (mostly OK) |

---

## Before / after blocking lists

### Bug #23 Complete → Rate

**Before (blocking):** ownership/GPS gate → Edge complete → payment gate RPC → waiting finalize → status=completed writes → settlement reads → **await Revolut finalize OR await TEN** → stacked promote → respond → seed Rate.

**After (blocking):** ownership/GPS gate → Edge complete → payment gate → waiting finalize → status=completed + fare stamp → stamp `capture_requested` (or tip window) → **queue** finalize/TEN via `scheduleEdgeBackground` → respond with `payment_capture_deferred: true` → seed Rate.

**Moved to durable background:** Revolut finalize-trip-and-capture; tip-window TEN posting. Recovery: `sweep-revolut-stale-holds` / `capture-expired-tip-windows` already include `capture_requested`.

### Bug #24A Submit

**Before:** paint → eligibility fetch → tip=0 close (async) → rating write → pending RPC → **toast 2.2s** → Home.

**After:** paint → rating write → Home immediately → tip close / pending hydrate async.

### Bug #24B Submit + tip

**Before:** paint → eligibility → **await tip settle (Revolut)** → rating → pending RPC → toast → Home.

**After:** paint → rating write → Home → **background tip settle** (failure Alert after Home; rating already saved). Never shows tip as paid from client optimism — server `tip_window_closed_at` remains authority.

### Bug #24C Skip

**Before:** paint → dismiss write → **await pending RPC** → Home.

**After:** paint → dismiss write → Home → pending hydrate async.

---

## Timing evidence (code / isolated — not device)

| Path | Isolated evidence |
| --- | --- |
| Bug #23 deferred capture | Execution test: Rate-ready before 250ms background finalize; `toRateMs < 100` in isolated clock |
| Bug #24A/B | Execution test: Home before tip settle completes |
| Bug #24C | Execution test: Home while tip close still pending |

**Targets (&lt;2s / &lt;1s) are not claimed achieved on production devices.**

---

## Financial safety

- Same `finalize-trip-and-capture` SSOT; no duplicate capture pipeline.
- `payment_status=capture_requested` stamped before return; sweepers retry.
- Tip 100% to driver unchanged (`DRIVER_TIP_CREDIT`); tip fail after rating still leaves rating saved.
- Tip never marked paid client-side before server confirmation.
- Platform-collected / driver-collected models unchanged.
- Incremental auth / waiting / airport / commission SSOT untouched.

---

## Changed files

**admin-new**
- `supabase/functions/stop-workflow/index.ts`
- `supabase/functions/_shared/completeTripCaptureDeferralLock.test.ts` (new)
- `docs/audits/2026-11-15_bugs_23_24_performance_report.md` (this file)

**onecab-customer-native**
- `src/features/booking/screens/RateTripScreen.tsx`
- `src/features/booking/lib/rateTripButtonResponsivenessLock.test.ts`
- `src/features/booking/lib/ratingThanksCopy.ts`
- `src/features/booking/lib/rateTripHomeTransitionPerf.ts` (new)
- `src/features/booking/lib/rateTripHomeTransitionPerfLock.test.ts` (new)
- `src/features/booking/lib/rateTripHomeTransition.execution.test.ts` (new)

**onecab-driver-native**
- `src/features/trip/lib/completeTripCaptureDeferral.execution.test.ts` (new)

---

## CI / SHAs

| Repo | SHA | CI |
| --- | --- | --- |
| admin-new (code) | `ceceb1f1107d28051f40e05f922eae33afef2354` | [success](https://github.com/awehliye44-create/admin-new/actions/runs/43713776513) |
| admin-new (report tip) | `753d25f728f40a67b968498ac9a15894dab5d319` | docs follow-up |
| onecab-customer-native | `b8018b3a595a82633e431e30602ea194f8a38e85` | [success](https://github.com/awehliye44-create/onecab-customer-native/actions/runs/43713778824) |
| onecab-driver-native | `03a31b9583bd725526949078962add98c4be0a70` | [success](https://github.com/awehliye44-create/onecab-driver-native/actions/runs/43713781783) |

Production pins (unchanged until deploy approval): Customer OTA `f25365ba`; Driver OTA `9db6b5cc`; migration head `20270225140000`; `stop-workflow` **v672** still live. No Edge / OTA / native / store deploy from this change set.

---

## Required production deploy (when approved)

1. Edge: **`stop-workflow`** from tip containing Bug #23 deferral (will become v673+).  
   Do **not** redeploy unrelated functions unless needed.
2. Customer OTA from Customer tip (JS-only; OTA-compatible).
3. Driver OTA optional for telemetry-only; Complete→Rate win is primarily Edge.

**Migrations:** none for this performance change.

---

## Remaining bottlenecks

- Edge pre-complete sequential reads / Auth `getUser` still on path (~hundreds of ms).
- Far-from GPS refresh up to 4s when cached fix is far (user-location, not finance).
- Tip>0 still runs full Revolut in background — Home is fast, tip confirmation remains async.
- Customer tip Edge still awaits capture when invoked — only the client no longer waits.
- Stacked promotion still awaited on Complete (usually small).

---

## Rollback

1. Redeploy prior `stop-workflow` (v672).  
2. Customer OTA rollback to prior production group.  
3. Driver OTA rollback if published.

---

## Recommended deployment order (paused)

1. Deploy `stop-workflow` (Bug #23).  
2. Customer OTA (Bug #24).  
3. Optional Driver OTA.  
4. Measure production device timings before declaring targets met.
