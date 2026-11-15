# Bug #17 — Live Trip remaining implementation & readiness report

**Date:** 2026-11-15  
**Scope:** Customer Live Trip (ActivityKit + Android ongoing) hardening  
**Production remote delivery:** **DISABLED** (confirmed after remediation)

---

## Verdict

Implementation and verification for photos, push-to-start, APNs credential shape, ETA/kill-switch contracts, and regression locks are complete. **No native builds, store submissions, or global fanout enablement.** Real-device acceptance remains with you.

---

## 1. APNs credential verification (safe)

Service-role probe via `refresh-customer-live-trip-etas` `{ "probe_apns": true }` — **no secret values returned**.

| Check | Result |
|-------|--------|
| Key ID present + shape | PASS |
| Team ID present + shape | PASS |
| P8 PEM shape | PASS |
| P8 import + JWT mint (ES256) | PASS |
| Bundle ID | `com.onecab.customer.app` |
| Live Activity topic | `com.onecab.customer.app.push-type.liveactivity` |
| Topic matches expected bundle | PASS |

**Credential mismatch:** none identified. No revoke/regenerate/expose performed.

### Kill-switch remediation (safety)

Probe initially showed env secrets `CUSTOMER_LIVE_TRIP_*_ENABLED=true` **overriding** DB `customer_live_trip_settings.enabled=false`, which would have allowed remote fanout.

**Action taken:** set

- `CUSTOMER_LIVE_TRIP_ENABLED=false`
- `CUSTOMER_LIVE_TRIP_ANDROID_ENABLED=false`
- `CUSTOMER_LIVE_TRIP_IOS_ENABLED=false`

**Re-probe after set:**

- `gates.globalEnabled/androidEnabled/iosEnabled = false`
- `kill_switch.env_* = false`
- `db_enabled = false` (platform DB flags remain `android_enabled/ios_enabled=true` but ineffective while global/env off)

APNs secrets themselves were **not** rotated.

---

## 2. Driver + vehicle photo rendering

### iOS (ActivityKit)

- Shared `OneCabLiveTripPhotoStore` (App Group `group.com.onecab.customer.app`)
- Host app prefetches signed photos → App Group files before activity update
- Widget renders local `UIImage` when file URL present; otherwise `AsyncImage` for remote/push-to-start paths
- Vehicle photo replaces SF Symbol-only placeholder on Lock Screen + Dynamic Island
- Identity keys include `assignedDriverId` + path-stripped photo identity (never show previous driver/vehicle)
- Epoch purge on rematch / end
- Neutral placeholders on missing/failed downloads

### Android (ongoing notification)

- `ImageView`s for driver + vehicle in custom RemoteViews
- `LiveTripPhotoDownloader` + epoch-gated apply (`shouldApplyImage`)
- Identity-stripped signed URL rotation; clear bitmaps on rematch/end
- API 36 ProgressStyle: `setLargeIcon(driverBitmap)` when available (custom RemoteViews still not used for promotion)

### JS fingerprint

- `liveTripPhotoMaterialIdentity` — signed query expiry does not thrash native coalesce

---

## 3. iOS push-to-start readiness

| Item | Status |
|------|--------|
| `pushToStartTokenUpdates` (iOS 17.2+) | Present; buffered when RN listeners not yet attached |
| Activity `pushTokenUpdates` | Observed + registered |
| Token register preserves sibling activity / PTS | Hardened |
| Publish `event=start` prefers `push_to_start_token` | Wired via `selectLiveActivityPushToken` |
| Publish `update`/`end` prefers activity token | Wired |
| APNs topic / attributes-type for start | Unchanged contract |
| Unsupported &lt; 16.2 | `isAvailable` → false; JS capability soft-gate |
| Unsupported 16.2–17.1 | Local ActivityKit start when app runs; remote push-to-start unavailable (OS limit) |

Deployed Edge: `publish-customer-live-trip`, `register-customer-live-activity-token`, `refresh-customer-live-trip-etas`.

---

## 4. Background ETA + lifecycle safeguards (verified in code/tests)

Preserved:

- Cache-only ETA (`peekTripRouteCacheLeg`) — no paid routing from Live Trip publish/refresh
- No additional continuous GPS for Live Trip
- Coalesce ~35s for routine ETA ticks
- Immediate lifecycle / assignment / terminal priority
- Assignment generation + presentation version + epoch stale protection
- Rematch clears driver/vehicle atomically
- Scheduled pre-activation never eligible
- Global vs Android vs iOS gates independent; env kill switches now false

While fanout is off, cron path no-ops / emergency-ends rather than refreshing live cards.

---

## 5. Regression verification

| Suite | Result |
|-------|--------|
| Customer Live Trip (lock/content/rematch/coordinator/eligibility) | PASS |
| Backend Live Trip APNs / ETA / eligibility / projection Deno tests | PASS |
| Samsung book / photo soft-skip / private contact / VoIP / CTC / session / bank-decline / version / map light | PASS (map lock updated to viewport host for `styleURL`) |
| Paid bookings / physical device / simulator | **Not run** (per brief) |

Bug #28 payment / OTA trains were not modified in this pass.

---

## 6. Remaining OS / product limitations

1. **iOS push-to-start** requires iOS 17.2+ and Live Activities allowed; older OS: local start only when app is foreground/background-capable.
2. **App Group** `group.com.onecab.customer.app` must be enabled on App ID + provisioning for Bug #21 native build (photo file share). Without it, remote `AsyncImage` still works; local prefetch is best-effort.
3. **Android API 36** Live Updates use ProgressStyle (no custom photo RemoteViews); driver photo via large icon only.
4. **Terminated-app delivery** still depends on APNs/FCM + tokens; with fanout disabled, remote start will not fire until enablement.
5. Widget entitlements now include App Group — automatic provisioning may need a one-time Apple portal / Xcode capability enable.

---

## 7. Native build readiness (Bug #21) + Play versionCode (Bug #20)

### Current store identity (locked)

| Platform | Version | Native |
|----------|---------|--------|
| iOS | 1.0.6 | build **23** / runtime `1.0.6(23)` |
| Android | 1.0.6 | versionCode **46** / runtime `1.0.6(46)` |

### Bug #20 — Google Play versionCode

Before any Play upload for the Live Trip native train:

1. Confirm Play Console **highest released/draft versionCode** for `com.onecab.customer.app`.
2. Ship `versionCode` **strictly greater** than that value (today’s tree is **46**; if Play already has ≥46, bump in `app.config.ts` + `android/app/build.gradle` together).
3. Keep `versionName` / Expo `version` aligned with the approved marketing train.
4. Do **not** upload a development APK over Play; use release signing only when explicitly approved.

### Bug #21 — Consolidated native build requirements

**Must rebuild native (not OTA-only)** because:

- App Group entitlements (host + `OneCabLiveTripWidget`)
- New Swift: `OneCabLiveTripPhotoStore.swift` (app + widget)
- Widget UI + module photo prefetch / token buffer
- Android: layout ImageViews, `LiveTripPhotoDownloader.kt`, notification bitmap path
- Plugin `withOneCabLiveTripActivity.js` sync surface

**Pre-build checklist**

1. Apple Developer: enable App Group `group.com.onecab.customer.app` on App ID + regenerate profiles if needed.
2. Xcode: confirm both targets include App Group + PhotoStore in Sources.
3. Android: local `assembleRelease` / Play AAB only when approved — **no EAS cloud** unless explicitly approved.
4. Bump versionCode/buildNumber if Play/App Store already consumed 46/23.
5. Keep `customer_live_trip_settings.enabled=false` and env `CUSTOMER_LIVE_TRIP_*=false` until post-native acceptance.
6. After native install: device QA of photos, push-to-start (iOS 17.2+), rematch, terminal end, then staged enable.

**Explicitly deferred**

- Native builds / store submission / public rollout
- Flipping global or platform remote delivery on

---

## 8. Implementation change summary

### Backend (`admin-new`)

- `customerLiveTripApns.ts` — probe + `selectLiveActivityPushToken`
- `publish-customer-live-trip` — start uses push-to-start token
- `register-customer-live-activity-token` — preserve sibling tokens
- `refresh-customer-live-trip-etas` — APNs + kill-switch probe
- Env kill switches forced `false` (DB already `enabled=false`)

### Customer (`onecab-customer-native`)

- iOS photo store + widget vehicle/driver photos + token event buffer
- Android photo download + layout ImageViews
- Plugin App Group + file sync
- Fingerprint signed-URL material identity
- Map light lock points at MapView viewport host

---

## 9. Stop conditions

No remaining genuine credential mismatch. Fanout safety gate was corrected (env false). Ready for your real-device acceptance after the next approved native build (Bug #21), still with remote delivery off until you approve enablement.
