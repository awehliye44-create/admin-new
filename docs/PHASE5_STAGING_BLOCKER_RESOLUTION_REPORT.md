# Phase 5 — Staging Blocker Resolution Report

**Date:** 2026-11-12  
**Production:** untouched  
**Phase 6:** not started  
**Recommendation:** **NO-GO** (capability gate shipped to isolated branches; physical notification matrix still blocked)

---

## Final SHAs (isolated Phase 5 branches)

| Repo | Branch | SHA |
|------|--------|-----|
| Backend (`admin-new`) | `release/scheduled-departure-ack-phase5` | *(see git log after push)* |
| Driver (`onecab-driver-native`) | `release/scheduled-departure-ack-phase5` | *(see git log after push)* |

---

## 1. Capability-gate evidence

Capability is the **OTA-loaded JS bind list** `scheduled_departure_ack_v1`, not native `app_version` / `runtimeVersion`.

| Requirement | Evidence |
|-------------|----------|
| Registration on bind | Driver sends `client_capabilities: [...DRIVER_CLIENT_CAPABILITIES]`; Edge upserts onto `driver_active_devices` |
| Refresh after OTA | Foreground/AppState rebind replaces capabilities with loaded update list |
| Removal after older OTA rollback | Bind with missing/empty list → `[]` replace; DB demo: same `1.0.6` + device, token cleared → `has_token=f` |
| Stale registrations | `claim=false` refresh rejected if installation ≠ active; capability read only from active row |
| Multiple devices | Sole `driver_active_devices` row; push via `resolveDriverAuthoritativeToken` same `device_id` |
| Missing/unknown → Phase 4 NRO | `resolveDepartureAckExecutionModeForDriver` → `ack_nro` |
| No direct activation | Runner never `activate_now`; en_route only after Heading to Pickup ack |
| Same native, older OTA | Unit: `app_version=1.0.6` + empty caps → `capability_missing` → `ack_nro` |
| Version alone never grants | Unit: `9.9.9` without token → `ack_nro` |

Migration: `20270215130000_scheduled_departure_ack_capability_gate.sql`  
Drain helper: `migrations/rollback/drain_scheduled_departure_ack_phase5.sql`

---

## 2. Physical-device preparation

| Item | Result |
|------|--------|
| Samsung A16 / Motorola Edge 40 | **Not connected** (`adb devices` empty) |
| iPhone 15 Pro Max | **Offline** |
| Local API | `127.0.0.1:54321` and LAN `172.20.10.5:54321` REST **200** |
| QA env | `.env.qa` → `local-docker` + LAN URL (not production) |
| QA Firebase | `android/app/src/qa/google-services.json` present |
| Production OTA | **Not published** |
| Loaded update identities | **Not verified** (no device session) |

---

## 3. Mixed-version compatibility

Local isolated environment only.

| Case | Result |
|------|--------|
| A. No `scheduled_departure_ack_v1` | Unit + SSOT → `ack_nro` (Phase 4 exclusive NRO). Device UI not exercised. |
| B. With capability + flag on | Unit → `departure_ack` / `arm_ack` / 45s. Device UI not exercised. |
| C. Multi-device | Active-device-only bind + authoritative push; historical tokens wiped on bind. Physical multi-device not run. |

Flag left **false** after drills (`scheduled_departure_ack_enabled=false`, `jit_auto_activate_enabled=false`).

---

## 4. Physical notification matrix

**Not executed** — no physical devices attached.

| Limitation | Detail |
|------------|--------|
| Precise blocker | Zero USB/wireless Android; iPhone offline |
| Remote push on local Docker | Even with devices, FCM/APNs delivery to physical phones against local Edge requires reachable API **and** valid Firebase/APNs credentials for the QA package; local Docker does not provide production APNs/FCM routing |
| Minimum extra infrastructure | (1) Attach the three devices; (2) install `com.onecab.driver.app.qa` pointed at LAN `:54321`; (3) QA Firebase project with FCM for `.qa` + iOS push key; (4) keep Metro/dev-client or local test update **non-production** |

Unit tests were **not** substituted for this matrix.

---

## 5. Drain-first rollback drill (real pending session)

Fixture trip `bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1` on local Docker:

| Step | Result |
|------|--------|
| Arm pending 45s | `pending_count=1`, `window_seconds=45`, flag temporarily on |
| Disable Phase 5 flag while pending | `deadline_unchanged=t`, flag off, status still `pending` |
| Late ack after deadline | **0 rows** updated; status remained `pending`; no driver assigned |
| Timeout recovery | **1** timed_out row → `searching` / instant; driver excluded |
| Second timeout | **0** rows (exactly once) |
| Pending after drain | **0** |
| Flags after | both false |

Prior Edge restore: only after pending=0 (satisfied for this fixture).

---

## 6. Migration + Edge manifest (local)

Migrations applied locally: `20270214120000`, `20270215120000`, **`20270215130000`**.

Edge served locally (OPTIONS OK): scheduled-dispatch, schedule-dispatch, scheduled-checkin, scheduled-ride-action, admin-scheduled-ride-action, accept-offer, auto-dispatch, expire-offers, decline-trip, bind-driver-device-token.

---

## Remaining blockers

1. Physical devices not connected → no loaded update identity, no notification matrix, no live mixed-version UI.
2. Local Docker cannot fully exercise remote push without QA FCM/APNs + attached devices.
3. Production still must not receive these migrations/Edge/OTA.

## Production GO/NO-GO

# **NO-GO**

Capability-gate corrections are on the isolated Phase 5 branches. Revisit GO only after physical §3/§4 pass on QA installs against non-production backend.
