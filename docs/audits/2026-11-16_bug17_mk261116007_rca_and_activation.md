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

## Production verification (2026-11-16)

| Check | Result |
| --- | --- |
| Edge `publish-customer-live-trip` | Deployed |
| DB `customer_live_trip_settings` | `enabled/android/ios = true` |
| Env kill switches | all `true` |
| APNs probe | configured; JWT mint OK; topic matches bundle |
| Gates after probe | `global/android/iosEnabled = true` |
| Admin commit | `2c7d6288` |
| Customer commit | `d685e46` |
| OTA Android `1.0.6(46)` (released store) | `01a1e5b2-9c7b-76a1-9738-27ac4609867e` |
| OTA iOS `1.0.6(23)` (released store) | `01a1e5b2-9c7b-7729-b0d9-e12e977173cf` |
| OTA Android `1.0.6(47)` / iOS `1.0.6(24)` tip | also published |

**Device QA still required:** background + lock-screen Live Trip on a real Android 1.0.6(46) Customer after OTA cold start, then one live trip.

## Scheduled / privacy

Unchanged: eligibility SSOT blocks pre-activation scheduled holds; lock-screen content remains first-name / vehicle / ETA / status only (no phone, addresses, payment).
