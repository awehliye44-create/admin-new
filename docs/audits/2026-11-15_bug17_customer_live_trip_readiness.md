# Bug #17 — Customer Live Trip readiness (audit only)

**Date:** 2026-11-15  
**Mode:** Read-only. No implementation, Edge deploy, OTA, native build, store submission, or secret rotation.  
**Tracking alias:** Stream **B9** (Live Trip packaging) in prior release docs. Remote fanout remains **disabled**.  
**Customer HEAD includes Bug #28:** `498e603` (ancestor OK).

---

## Executive verdict

Live Trip is **implemented end-to-end in code** (Customer native + JS + backend projection/ETA/APNs/FCM) but **not production-ready to enable**.

| Gate | State |
| --- | --- |
| Global fanout | **OFF** — `customer_live_trip_settings.enabled = false` |
| Platform DB flags | `android_enabled=true`, `ios_enabled=true` (ineffective while global off) |
| Env kill switches | `CUSTOMER_LIVE_TRIP_ENABLED` / `_ANDROID_` / `_IOS_` secrets **present** (same “off” digest family as other disabled flags) |
| Migrations / tables | **Present** in production |
| Edge functions | **Deployed** (`publish` v4, `register-token` v4, `refresh-etas` v1) |
| ETA cron | **Active** (`customer-live-trip-eta-refresh` every minute) — force-ends when global off |
| APNs Live Activity secrets | **Present** (`APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_AUTH_KEY_P8`, `APNS_CUSTOMER_BUNDLE_ID`) — **do not regenerate** |
| FCM | **Ready** via existing `GOOGLE_SERVICE_ACCOUNT_JSON` (+ legacy `FCM_SERVER_KEY`) |
| ActivityKit tokens registered | **0** (expected while fanout/local packaging incomplete) |
| Photos on Lock Screen | **Partial** — URLs projected; Android does not render bitmaps; iOS `AsyncImage` unreliable; vehicle photo not shown |
| Real-device / TestFlight proof | **Missing** |
| Native binary requirement | **1.0.6(23) iOS / 1.0.6(46) Android** (soft-gated no-op on 1.0.5) |

**Do not flip `enabled=true` until the recommended plan below is complete.**

---

## 1. Completed components

### Customer (native + JS)
- ActivityKit + WidgetKit Lock Screen / Dynamic Island (`ios/OneCabLiveTripWidget/**`, `LiveTripActivityModule`)
- Android ongoing notification + native FCM receiver (`LiveTripOngoingNotification`, `LiveTripFcmReceiver`, channel `onecab_live_trip_v1`)
- Expo plugin `plugins/withOneCabLiveTripActivity.js`
- Coordinator, rematch epoch, fingerprint coalesce, FG/BG lifecycle (`src/features/liveTripActivity/**`)
- Capability gate: `LIVE_TRIP_MIN_IOS_BUILD_NUMBER=23`, `LIVE_TRIP_MIN_ANDROID_VERSION_CODE=46`
- Lock tests: `liveTripActivityLock.test.ts`, `liveTripActivityRematchLock.test.ts`, eligibility/content tests
- Rule: `.cursor/rules/live-trip-lock-screen-lock.mdc`

### Backend
- Tables: `customer_live_trip_projections`, `customer_live_activity_tokens`, `customer_live_trip_settings`
- Edge: `publish-customer-live-trip`, `register-customer-live-activity-token`, `refresh-customer-live-trip-etas`
- SSOT: projection, eligibility, ETA (cache-only), APNs liveactivity, feature flags, best-effort publish from trip lifecycle + `trip-route`
- Coalesce ~35s for routine updates; lifecycle / assignment / rematch / arrival / terminal bypass
- When global off: publish path force-ends; ETA sweep ends open projections
- Privacy SSOT: first name only; no phone, email, addresses, fare, or payment on the card

### Credentials already in Supabase (names only — digests listed by CLI)
| Secret | Purpose |
| --- | --- |
| `APNS_KEY_ID` | Apple Push Auth Key ID |
| `APNS_TEAM_ID` | Apple Team ID |
| `APNS_AUTH_KEY_P8` | `.p8` private key (Live Activity topic) |
| `APNS_CUSTOMER_BUNDLE_ID` | Customer bundle (default `com.onecab.customer.app`) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | FCM HTTP v1 (Android Live Trip + existing push) |
| `CUSTOMER_LIVE_TRIP_ENABLED` | Global env override (currently off-family) |
| `CUSTOMER_LIVE_TRIP_ANDROID_ENABLED` | Android env override |
| `CUSTOMER_LIVE_TRIP_IOS_ENABLED` | iOS env override |

**Previously reported missing APNs trio is no longer missing** (updated 2026-11-14). Ordinary customer alerts still go through FCM; Live Activity iOS updates use these APNs secrets with topic `<bundle>.push-type.liveactivity`.

---

## 2. Missing / incomplete components

| Gap | Severity | Notes |
| --- | --- | --- |
| Packaging / real-device QA | **Blocker** | No recorded TestFlight/Play binary proof that LA starts, updates in background, and ends |
| Global enable still false | Intentional | Keep off until QA |
| Photo rendering | Medium | Driver/vehicle URLs in projection; Android no bitmap load; iOS AsyncImage limited; vehicle photo unused in Swift UI |
| iOS remote **start** token path | Medium | `push_to_start_token` selected but not used for `event: start`; local `Activity.request` is primary start when app is alive |
| Push-to-start NULL `trip_id` uniqueness | Low | Postgres NULL uniqueness may allow duplicate token rows |
| Signed photo TTL vs long-lived card | Medium | Hourly JWT URLs can expire while card is up |
| Field fleet on 1.0.5 | Ops | Soft-gated off until native 1.0.6 train is installed |
| Admin UI toggle | Low | Enable/disable is SQL/env only |

---

## 3. APNs credential requirements (what you need to provide)

**Do not revoke or regenerate existing working push credentials.**

### Can existing Apple credentials be reused?
**Yes.** A standard Apple Push Notifications Auth Key (`.p8`) for Team **that owns** `com.onecab.customer.app` is the correct credential for Live Activity pushes. Delivery differs only by:
- Topic: `com.onecab.customer.app.push-type.liveactivity`
- Header: `apns-push-type: liveactivity`

Regular FCM/APNs alert push does **not** need a second Apple key.

### What is missing from you right now?
**Likely nothing new to create**, if the secrets already stored are the correct production Auth Key for this Team/bundle.

Please **confirm** (no paste of the private key into chat unless rotating):

1. `APNS_KEY_ID` / `APNS_TEAM_ID` / `APNS_AUTH_KEY_P8` belong to the Apple Developer team for **ONECAB Customer** (`com.onecab.customer.app`).
2. `APNS_CUSTOMER_BUNDLE_ID` equals `com.onecab.customer.app`.
3. Whether TestFlight QA should prefer sandbox host temporarily (`APNS_HOST=https://api.sandbox.push.apple.com`) — optional; code already falls back between production and sandbox on 400.

**Only provide a new `.p8` / Key ID if confirmation fails** (wrong team, revoked key, or key never uploaded). Prefer uploading via `supabase secrets set` yourself; do not commit the P8 to git.

### Android FCM
Already production-ready for Live Trip data messages (`type=live_trip_update`) via existing Firebase / `GOOGLE_SERVICE_ACCOUNT_JSON`. No new Firebase project required. Native `LiveTripFcmReceiver` handles updates without JS.

---

## 4. Server-side ETA / background delivery

| Behaviour | Status |
| --- | --- |
| Reuses `trip_route_cache` / `last_eta_*` | Yes — **no extra paid routing** |
| No extra continuous GPS | Yes — uses existing driver location / route cache |
| Ordinary ETA throttle | Client publish ~60s; server coalesce ~35s; cron every 1 min |
| Lifecycle immediate | assignment / rematch / arrival / terminal bypass coalesce |
| Stale assignment protection | `assignment_generation` + presentation version + client epoch |
| Independent of FG app | Android: native FCM receiver. iOS: ActivityKit push updates **after** a local (or valid push-to-start) activity exists |
| Scheduled pre-activation | Eligibility blocks premature Live Trip for future scheduled holds |

While `enabled=false`, cron still runs but **force-ends** rather than refreshing live cards.

---

## 5. Required card information vs current UI

| Required | Projected | Shown on Lock Screen today |
| --- | --- | --- |
| Trip status | Yes | Yes |
| Driver first name | Yes | Yes |
| Driver photo | URL yes | iOS: best-effort AsyncImage; Android: **not rendered** |
| Driver rating | Yes (if count > 0) | Yes (text) |
| Vehicle photo | URL yes | **Not rendered** (car SF Symbol / RemoteViews text) |
| Make / model / colour | Yes | Yes (text) |
| Registration | Yes | Yes (intentional Lock Screen visibility) |
| ETA + progress | Yes | Yes |
| Phone / addresses / payment | **Absent** (correct) | — |

---

## 6. Lifecycle safeguards (code coverage)

| Event | Covered |
| --- | --- |
| Driver assigned | Yes |
| Heading to pickup | Yes |
| Arrived / waiting | Yes |
| Trip started | Yes |
| Intermediate stops | Yes |
| Completed / cancelled / no-show | Terminal → end activity |
| Reassignment / rematch | Same `tripId`; generation bump; clear prior driver/vehicle |
| Scheduled activation | Pre-activation gate — no premature active card |

---

## 7. Preserve production fixes

- Customer master includes through **Bug #28** (`498e603`).
- Live Trip work must not regress booking, payment, scheduled dispatch, waiting, rating, trip-mod, OTA, single-device, VoIP, or map locks.
- Enabling Live Trip is **server flag + native-capable binaries** only — no need to re-ship Bug #28 JS for fanout itself.

---

## 8. Native build requirements

| Runtime | Live Trip |
| --- | --- |
| iOS `1.0.6(23)` / Android `1.0.6(46)` | Native modules present; feature **can** run once fanout on |
| iOS `1.0.5(22)` / Android `1.0.5(45)` | Soft-gated **no-op** |

**Store/TestFlight packaging is still the packaging gap (B9).** Remote delivery must stay disabled until a verified 1.0.6 (or later) binary is installed on QA devices and push update/end is proven.

JS OTA can adjust coordinator/eligibility/copy **after** native is on device; new ActivityKit attributes or Kotlin/Swift UI changes need another native build.

---

## 9. Remaining risks

1. Flip-on without device QA → silent no-op or stuck cards.  
2. iOS update push before any local activity / broken push-to-start → no Lock Screen card when app killed at assign.  
3. Expired signed photo URLs on long trips.  
4. Plate visible on locked device (product accept).  
5. Env vs DB flag conflict if env secrets stay “false” while SQL is set true — resolve env before enable.  
6. `aps-environment` development in committed entitlements — verify distribution profile for TestFlight/App Store.

---

## 10. Recommended implementation & release plan (not started)

**Phase 0 — Confirm credentials (you)**  
Validate existing APNs Key ID / Team / P8 for Customer bundle. Do **not** regenerate if valid.

**Phase 1 — Device packaging (native)**  
Install/verify Customer **1.0.6(23)/(46)** (or newer) with Live Trip plugin on QA devices. No fanout yet.

**Phase 2 — Local-only smoke (fanout still off)**  
Foreground assign → local Activity/ongoing appears from coordinator. Rematch clears driver A. Complete/cancel ends card.

**Phase 3 — Android remote first**  
Set env/DB so global + Android on, **iOS off**. Prove FCM `live_trip_update` updates shade with app backgrounded/killed. No extra routing.

**Phase 4 — iOS remote**  
Enable iOS after APNs liveactivity update/end proven on TestFlight. Fix push-to-start wiring only if killed-at-assign fails.

**Phase 5 — Photo polish (optional native)**  
Render vehicle/driver images where ActivityKit/ongoing allow; refresh signed URLs with assignment epoch.

**Phase 6 — Controlled production enable**  
`customer_live_trip_settings.enabled=true` (+ align env secrets). Monitor token register, 410 invalidations, terminal end rate.

**Out of scope until approved:** implementation, Edge redeploy, OTA, native EAS/store builds, enabling fanout.

---

## Production snapshot (2026-11-15)

```
customer_live_trip_settings: enabled=false, android_enabled=true, ios_enabled=true
Edge: publish-customer-live-trip v4, register-customer-live-activity-token v4, refresh-customer-live-trip-etas v1
cron: customer-live-trip-eta-refresh ACTIVE * * * * *
customer_live_activity_tokens: 0
customer_live_trip_projections: 17 historical rows
APNs Live Activity secrets: PRESENT (do not rotate blindly)
FCM service account: PRESENT
Remote delivery: DISABLED
```

**Bug #17 / B9 status:** OPEN — packaging + device proof; fanout remains off.
