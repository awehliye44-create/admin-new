# Phase 4 + Phase 5 — Controlled Staging Verification Report

**Date:** 2026-11-12  
**Recommendation:** **NO-GO for production**  
**Phase 6:** not started

Approved RCs under test:

| Component | Commit |
|-----------|--------|
| Backend | `215bbe1b` (+ staging capability-gate follow-ups below) |
| Driver | `2f2b483` (`APP_VERSION` 1.0.6) (+ capability advertise on bind) |
| Phase 4 dependency | `71331048` |

---

## 1. Environment safety

| Item | Result |
|------|--------|
| Isolated staging | **Local Docker Supabase only** (`http://127.0.0.1:54321`, DB `54322`, container `supabase_db_thazislrdkjpvvghtvzo`) |
| Cloud staging project | **None available** — no separate staging Supabase project was found |
| Production project | **Not deployed / not configured / not migrated** for this exercise |
| Real customers / drivers / payments | Unaffected |

> Note: Docker container names reuse the production project ref string for local CLI wiring. API/DB endpoints used were loopback only.

---

## 2. Staging migration + Edge

### Migrations (applied to local Docker DB)

1. `20270214120000_scheduled_jit_activation_phase4.sql` — applied (idempotent re-run OK)
2. `20270215120000_scheduled_departure_ack_phase5.sql` — applied (idempotent re-run OK)
3. `20270215130000_scheduled_departure_ack_capability_gate.sql` — **added for §4** and applied

Recorded in `supabase_migrations.schema_migrations`: `20270214120000`, `20270215120000`, `20270215130000`.

### Flags (preserved fail-closed)

| Flag | Value |
|------|-------|
| `jit_auto_activate_enabled` | **false** |
| `scheduled_departure_ack_enabled` | **false** |
| `scheduled_departure_ack_seconds` | **45** |
| `scheduled_departure_ack_grace_seconds` | **0** |
| `scheduled_departure_ack_capability_key` | `scheduled_departure_ack_v1` |

Singleton `global_dispatch_settings` was empty on this local DB and was seeded with required radius columns; financial/dispatch defaults otherwise left at schema defaults.

### Combined Edge manifest (local `functions serve`)

Served on `http://127.0.0.1:54321/functions/v1/…`. OPTIONS reachability:

| Function | OPTIONS |
|----------|---------|
| scheduled-dispatch | 204 |
| schedule-dispatch | 200 |
| scheduled-checkin | 204 |
| scheduled-ride-action | 204 |
| admin-scheduled-ride-action | 200 |
| accept-offer | 204 |
| auto-dispatch | 204 |
| expire-offers | 204 |
| decline-trip | 200 |
| bind-driver-device-token | 204 |

No production Edge deploy. No production config changes.

---

## 3. Driver app physical-device testing

| Device | Status |
|--------|--------|
| Samsung A16 | **Not connected** (`adb devices` empty) |
| Motorola Edge 40 | **Not connected** |
| iPhone 15 Pro Max | **Offline** (`admin’s iPhone` listed offline; no USB session) |

| Item | Result |
|------|--------|
| Source commit on disk | `2f2b483` |
| App version (config) | `1.0.6` |
| Production OTA | **Not published** |
| Local test install | **Blocked** — no physical devices attached |
| Loaded update identity on device | **Not verified** |

---

## 4. Capability-aware activation (beyond global flag)

### Gap found

RC `215bbe1b` gated solely on `scheduled_departure_ack_enabled` → would arm `arm_ack` for **all** confirmed drivers once the global flag flips. That violates mixed-version requirements.

### Staging fix implemented (local; not production)

1. Migration `20270215130000_scheduled_departure_ack_capability_gate.sql`
   - `global_dispatch_settings.scheduled_departure_ack_capability_key`
   - `global_dispatch_settings.scheduled_departure_ack_min_app_version`
   - `driver_active_devices.client_capabilities` / `app_version`
2. SSOT `scheduledDepartureAckCapabilitySSOT.ts`
   - `driverSupportsDepartureAck` / `resolveDepartureAckExecutionModeForDriver`
3. `runConfirmedJitActivationPass` loads active-device capabilities **per confirmed driver**
   - capable → `departure_ack` (`arm_ack`)
   - missing capability / no active device / below min version → **`ack_nro`** (Phase 4 exclusive NRO)
4. `bind-driver-device-token` persists `client_capabilities` + `app_version`
5. Driver `2f2b483` tree: bind sends `client_capabilities: ['scheduled_departure_ack_v1']`
6. `scheduled-dispatch` settings select includes Phase 5 + capability columns

### Evidence (unit)

- Capability SSOT tests: **5/5 PASS**
- Departure-ack SSOT + source lock (includes capability wiring): **8/8 PASS**
- Driver capability lock test: **2/2 PASS**

With global flag **false**, even capable devices resolve to `ack_nro` (fail-closed). Older apps without the capability token remain on acknowledgement-safe Phase 4 NRO when the flag is later enabled for test drivers.

---

## 5. Scheduled departure end-to-end smoke

| Scenario | Result |
|----------|--------|
| Automatic marketplace publication | **Not executed** (no devices / no live booking seed against local Edge) |
| Driver accept + pre-confirm | Not executed |
| Directional instant prioritisation | Covered by Phase 4 lock/unit history; not re-run live |
| Compatible stacked journey defer | Unit PASS (`deferForCompatibleActiveJourney`) |
| Dynamic JIT departure calculation | Unit PASS (JIT SSOT suite) |
| Urgent audible departure alert | Not executed on device |
| Strict 45s countdown | Unit + PG concurrency PASS |
| Heading to Pickup | Code/lock PASS; device N/A |
| Customer live tracking only after ack | Not executed |
| Cancel Booking | Not executed on device |
| Automatic timeout | Unit + PG PASS |
| Offline reconnect within 45s | Design/unit (arm while offline); device N/A |
| Exclusion + 6-minute instant conversion | Not executed live |
| Preserve trip id / fare / payment auth | Payment gate retained in runner; live N/A |

**Actual timeout recovery latency:** not measured on device. Backend deadline is exact 45s (`grace=0`); expire/rescue gates ignore grace.

---

## 6. Notification verification

Physical iOS/Android foreground / background / locked / terminated / tap / countdown restore / repeating audible: **not executed** (no devices).

Documented Path A expectation (code):

- Reuses exclusive `NEW_RIDE_OFFER` / NRO alert path for OTA-compatible audible urgency
- Actions: Heading to Pickup / Cancel Booking via existing scheduled-checkin activation path
- Sound stop / stale dedupe: not device-validated in this run

**OTA Path A sufficiency:** **provisionally yes for JS/copy/bind capability** on current native runtime (`1.0.6` train), but **unproven** until physical notification matrix passes. Native rebuild only if mic/notification channel / NRO channel wiring is missing on the installed binary (not observed here because devices were unavailable).

---

## 7. Rollback verification

| Check | Result |
|-------|--------|
| Flag disable while pending | Drain helper added: `migrations/rollback/drain_scheduled_departure_ack_phase5.sql` |
| Deadlines not extended on disable | Unit: grace ignored; deadline exact |
| Late acks rejected | Unit: `canAcknowledgeDeparture` false at deadline; checkin `ACK_EXPIRED` |
| Pending complete or expire | Drain-first: disable arming → wait `scheduled_ack_status='pending'=0` → only then Edge/column rollback |
| No duplicate assignment | PG races PASS (ack vs timeout/cancel/reassign/payment) |
| Pre-Phase-5 Edge safety | **Drain-first required** before reverting Edge that cannot read/process `scheduled_ack_*` |

Local pending inventory after staging: **0**.

PG concurrency harness: **PASS** (after readiness fix for Postgres init race).

---

## 8. Automated verification summary

| Suite | Result |
|-------|--------|
| `scheduledDepartureAckCapabilitySSOT.test.ts` | 5 PASS |
| `scheduledDepartureAckSSOT.test.ts` | 8 PASS |
| `scheduledJitActivationSSOT.test.ts` | 16 PASS (earlier run) |
| `scheduledDepartureAck.integration.test.ts` (PG) | 1 PASS |
| Driver `driverDepartureAckCapabilityLock.test.ts` | 2 PASS |

---

## Remaining defects / blockers

1. **No cloud isolated staging project** — local Docker only; cannot mirror cron/push/APNs/FCM production-like paths fully.
2. **No physical devices attached** — Samsung A16, Motorola Edge 40, iPhone offline → E2E + notification matrix incomplete.
3. **Capability gate was missing from approved RC** — staging follow-up implemented locally; must be reviewed, committed, and included before any flag enablement.
4. **Live Edge smoke against seeded scheduled trips** not completed on local serve (auth/seed/booking harness not run end-to-end).
5. Working trees dirty with staging verification follow-ups (backend + Driver) — not committed (awaiting explicit commit request).

---

## Production GO / NO-GO

# **NO-GO**

Do **not**:

- deploy to production
- publish production OTA / native builds
- change production configuration
- enable `scheduled_departure_ack_enabled` for real drivers
- start Phase 6

### Minimum to reconsider GO

1. Commit + re-tag capability-gate follow-ups (backend + Driver bind advertise).
2. Attach Samsung A16, Motorola Edge 40, iPhone 15 Pro Max (or equivalents) with `2f2b483` (+ capability bind) loaded; confirm update identity.
3. Complete §5 E2E + §6 notification matrix on those devices against isolated staging (or documented local Docker + real push credentials).
4. Mixed-version proof: capable Driver gets `arm_ack`; older Driver on same flag gets `ack_nro`.
5. Execute drain-first rollback drill with a live pending ack session.
6. Review this report and explicitly approve any later production plan.
