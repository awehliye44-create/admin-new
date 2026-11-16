# Bug #17 — MK-261116-007 RCA + production activation

**Date:** 2026-11-16  
**Trip:** MK-261116-007  

## Root cause (exact)

The released Customer Android binary **did** embed `LiveTripFcmReceiver` + ongoing notification (`1.0.6` / versionCode **46**). Projection rows were written for the trip.

**Remote fanout was intentionally OFF:**

| Gate | Production value at failure |
| --- | --- |
| `customer_live_trip_settings.enabled` | `false` |
| `CUSTOMER_LIVE_TRIP_ENABLED` | `false` (env overrides DB) |
| `CUSTOMER_LIVE_TRIP_ANDROID_ENABLED` | `false` |
| `CUSTOMER_LIVE_TRIP_IOS_ENABLED` | `false` |

`publish-customer-live-trip` therefore persisted the projection but **did not submit FCM** `type=live_trip_update`. With no data message, the native background receiver never ran — this is **not** a missing native module and **not** a JS-session dependency failure.

Env `false` was set on 2026-11-15 after an APNs probe showed env `true` would have overridden DB `enabled=false`.

## Permanent fix shipped

1. **Runtime gate** — start/update FCM/APNs only for compatible trains (`1.0.6+` / Android ≥46 / iOS ≥23 / `live_trip_lock_screen_v1` capability). Terminal ends still fan out for cleanup.
2. **Customer bind** — `app_version` now includes native build `1.0.6(46)`; Live Trip capability advertised only when native module is locally available.
3. **JS FCM backup** — RNFirebase background handler + Expo background task call native sync; **native receiver remains primary** (no JS required).
4. **Feature flag tests** — env `false` must keep fanout off when DB is true.
5. **Production activation** — DB `enabled=true` + env Android/iOS/global `true` after Edge deploy; APNs credentials left untouched.

## Scheduled / privacy

Unchanged: eligibility SSOT blocks pre-activation scheduled holds; lock-screen content remains first-name / vehicle / ETA / status only (no phone, addresses, payment).
