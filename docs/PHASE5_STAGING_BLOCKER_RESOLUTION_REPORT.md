# Phase 5 — Staging Blocker Resolution Report

**Date:** 2026-11-12 (updated)  
**Production:** untouched (no deploy / OTA without Owner approval)  
**Phase 6:** started on isolated branch after Phase 4/5 code-complete  

---

## Final SHAs (isolated Phase 5 branches)

| Repo | Branch | SHA |
|------|--------|-----|
| Backend (`admin-new`) | `release/scheduled-departure-ack-phase5` | `a15e20d8` |
| Driver (`onecab-driver-native`) | `release/scheduled-departure-ack-phase5` | `0898190` |

Release packaging: `docs/PHASE45_PRODUCTION_RELEASE_MANIFEST.md`

---

## Code-complete verdict

# **CODE-COMPLETE GO** (Phase 5 flag remains **disabled**)

| Item | Status |
|------|--------|
| Capability gate beyond global flag | Shipped (`20270215130000` + SSOT + bind) |
| Strict 45s / atomic races / drain-first | Covered by unit + PG + local simulator E2E |
| Driver capability advertise | `0898190` |
| Physical notification matrix | **Deferred at Owner request** — accepted gap |
| Capability registration evidence | Successful Driver OTP login + active-device claim with `scheduled_departure_ack_v1` (sufficient for registration path) |

Do **not** enable `scheduled_departure_ack_enabled` until compatible Driver OTA adoption is verified.  
Do **not** deploy or publish OTA without explicit Owner approval.

---

## Capability-gate evidence

Capability is the **OTA-loaded JS bind list** `scheduled_departure_ack_v1`, not native `app_version` / `runtimeVersion`.

| Requirement | Evidence |
|-------------|----------|
| Registration on bind | Driver sends `client_capabilities`; Edge upserts onto `driver_active_devices` |
| Refresh after OTA | Foreground/AppState rebind replaces capabilities with loaded update list |
| Removal after older OTA rollback | Bind with missing/empty list → `[]` replace |
| Stale registrations | `claim=false` refresh rejected if installation ≠ active |
| Missing/unknown → Phase 4 NRO | `resolveDepartureAckExecutionModeForDriver` → `ack_nro` |
| Version alone never grants | Unit: high `app_version` without token → `ack_nro` |

Migration: `20270215130000_scheduled_departure_ack_capability_gate.sql`  
Drain helper: `migrations/rollback/drain_scheduled_departure_ack_phase5.sql`

---

## Physical notification matrix

**Deferred at Owner request.** Not a code-complete blocker. Owner will report application issues from normal operation.

---

## Drain-first rollback drill (local)

Fixture pending session: disable flag → deadlines unchanged → late ack rejected → timeout → pending 0 → flags false. See prior drill log in git history / simulator harness.

---

## Production actions still requiring Owner approval

1. Apply three migrations to production  
2. Deploy required Edge set (see manifest)  
3. Publish Driver OTA `0898190`  
4. Verify capability adoption on active devices  
5. Separately enable `scheduled_departure_ack_enabled`
