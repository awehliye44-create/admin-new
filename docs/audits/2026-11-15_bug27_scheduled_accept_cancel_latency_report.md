# Bug #27 — Scheduled Accept + Cancel latency (consolidated)

**Date:** 2026-11-15  
**Status:** **SHIPPED** (Edge + Driver OTA). Production &lt;2s UX **not claimed** until personal retest on new scheduled bookings.

---

## Production evidence (MK0007)

| Trip | Accept stamp | Driver cancel | Notes |
| --- | --- | --- | --- |
| **MK-261115-011** (`919e6f6d-…`) | 16:20:34.348Z | 16:20:50.511Z — `Vehicle issue`, CAS | Preconfirm normalize ~318ms later |
| **MK-261115-012** (`77e3e7fa-…`) | 16:22:47.972Z | 16:23:28.192Z — `Schedule conflict`, CAS | Preconfirm normalize ~131ms later; screenshot ~16:23 |

No prior `driver_scheduled_accept` / `driver_scheduled_cancel` rows in `app_performance_events` (telemetry added in this ship).

### Accept root cause (distinct from cancel)

1. **Client:** `onAccept` **awaited** `refreshMarketplaceAcceptEligibility()` (docs sync) **before** Edge accept.
2. **Client:** after Edge OK, **awaited** soft refresh (list RPCs + docs eligibility) **before** switching to Confirmed.
3. **Edge:** after authoritative `accept_scheduled_ride` + preconfirm, **awaited** marketplace broadcast + customer notify + driver notify before HTTP 200.

Required sync work that must stay: marketplace guard, commitment gate, journey/docs compliance, commission wallet gate, atomic accept RPC, preconfirm normalize.

### Cancel root cause

1. **UX:** no gold/check / “Cancelling…” — selection looked dead.
2. **Edge:** after durable CAS release + exclusion, **awaited** scheduled-dispatch / auto-dispatch, customer notify, marketplace broadcast.
3. **Client:** awaited soft refresh (incl. docs) before dismiss; failure also cleared the sheet.

---

## Implementation

### Backend (`admin-new` `535076b4`) — `scheduled-ride-action` **v592**

- Accept + `cancel_confirmed`: return after authoritative commit; post-commit via `scheduleEdgeBackground` / `EdgeRuntime.waitUntil`.
- Response includes `post_commit: "background"` + `stages_ms`.
- Lock: `scheduledRideActionLatencyBug27Lock.test.ts`.

### Driver (`0d8a5f2`, includes `f5b55a7` Bug #26)

- Accept: immediate Accepting…; no await eligibility; `promoteRequestedToConfirmed` + background invalidate/refresh; sticky Confirmed vs stale lists.
- Cancel: gold + checkmark + “Cancelling scheduled ride…”; dismiss only on success; background refresh; retry unlock on failure.
- Remove **Schedule conflict** from Driver reason list only (backend still accepts historical string).
- Telemetry → `ingest-telemetry` / `app_performance_events` (`driver_scheduled_accept` / `driver_scheduled_cancel`).
- Lock: `scheduledJobsLatencyBug27Lock.test.ts`.

---

## Regression (local)

| Suite | Result |
| --- | --- |
| Driver Jest Bug #27 / busy-first / data store | **PASS** |
| Deno `scheduledRideActionLatencyBug27Lock` | **PASS** |
| Preserved | Bugs #23/#24/#26 locks untouched; CAS/eligibility/payment/JIT policies unchanged |

No device / simulator / paid bookings (per approval).

---

## Release pins

| Surface | Value |
| --- | --- |
| Backend tip | `535076b4` |
| `scheduled-ride-action` | **v592** (was v591) |
| Driver tip | `0d8a5f2` (ancestor `f5b55a7`) |
| Customer OTA | **unchanged** (no dependency) |

### Driver production OTA (runtimes)

| Platform | Runtime | Update group | Update ID |
| --- | --- | --- | --- |
| iOS | `1.0.6(4)` | `4b8a5134-e4e1-46a9-82d7-b39ec97f16a7` | `01a1e018-32af-7d74-889f-e7786f1845a6` |
| Android | `1.0.6(64)` | `b99543bc-806a-4785-b52e-f87b58ea6155` | `01a1e019-02ab-70ad-9197-1879febd2bd0` |

Message: `release: Bug #27 scheduled Accept/Cancel latency (0d8a5f2 + f5b55a7)`  
Dashboards:  
- iOS: https://expo.dev/accounts/awehliye44/projects/onecab-driver-native/updates/4b8a5134-e4e1-46a9-82d7-b39ec97f16a7  
- Android: https://expo.dev/accounts/awehliye44/projects/onecab-driver-native/updates/b99543bc-806a-4785-b52e-f87b58ea6155

### Rollback

```bash
# Edge: redeploy scheduled-ride-action from commit before 535076b4 (prior v591 content)
# Driver OTA → Bug #26 groups:
eas update:rollback --branch production --group 61d3ce7a-78b3-4b77-9b6c-c35c7f041df5   # iOS
eas update:rollback --branch production --group 7ab5a638-2286-4f7b-be7d-b606d052bf6d   # Android
# Or dashboard rollback of groups 4b8a5134… / b99543bc…
```

### Adoption

Cold start applies OTA. **Do not claim under-2s until personal Accept/Cancel on new scheduled bookings**; then check `app_performance_events` for `driver_scheduled_accept` / `driver_scheduled_cancel` stage durations + `loaded_update_id`.
