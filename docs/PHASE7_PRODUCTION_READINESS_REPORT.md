# Phase 7 — Production Readiness Report

**Date:** 2026-11-12  
**Verdict:** **CODE-COMPLETE / READY FOR OWNER-APPROVED COORDINATED RELEASE**  
**Authorisation:** This report does **not** authorise production deploy, OTA publish, migration apply, or feature-flag enablement.

Physical-device notification matrix: **deferred (Owner)** — not a code-complete blocker.

---

## 1. Final release SHAs

| Component | Branch | SHA | Notes |
|-----------|--------|-----|-------|
| **Backend + Admin** | `release/scheduled-admin-monitoring-phase6` | **`89f17e2a`** | Owner-accepted Admin RC tip |
| Phase 6 feature | (same branch) | `d18e2804` | Monitoring board implementation |
| Phase 5 backend tip (ancestry) | `release/scheduled-departure-ack-phase5` | `a15e20d8` | **Confirmed ancestor** of `89f17e2a` |
| Capability-gate fix | (ancestry) | `2041d9ad` | **Confirmed ancestor** |
| Phase 4 JIT | `release/scheduled-jit-phase4` | `71331048` | **Confirmed ancestor** |
| **Driver** | `release/scheduled-departure-ack-phase5` | **`0898190`** (`0898190781c0e0dda740bf596e140bcaf42663cf`) | Advertises `scheduled_departure_ack_v1`; clean tip |

**Ancestry check:** Phase 6 tip includes approved Phase 4 + Phase 5 + capability-gate corrections.

**Exclusions (confirmed):**
- Phase 6 delta vs `a15e20d8` is Admin presentation/monitoring + docs only — **no** finance, dispatch-settings, wallet, commission, or deferred trip-capture implementation.
- Untracked local helper **`scripts/phase45-arm-live-ack-for-device-qa.sql`** is **not** on the release branch (excluded from RC).

Customer app: **no** Phase 4–6 OTA required for departure acknowledgement.

---

## 2. Migration manifest (guarded apply — order fixed)

Apply **only** these three files, in order, via the existing **guarded per-file** procedure (`scripts/build-guarded-migration-apply.py` / established ops pattern).

| # | File |
|---|------|
| 1 | `supabase/migrations/20270214120000_scheduled_jit_activation_phase4.sql` |
| 2 | `supabase/migrations/20270215120000_scheduled_departure_ack_phase5.sql` |
| 3 | `supabase/migrations/20270215130000_scheduled_departure_ack_capability_gate.sql` |

**Phase 6:** no new migrations.

**Forbidden:** blind `supabase db push`; migration history repairs; applying unrelated local migrations in the same window.

Migrations default / force:
- `jit_auto_activate_enabled = false`
- `scheduled_departure_ack_enabled = false`

---

## 3. Combined Edge deployment manifest

Deploy together from Admin RC tip `89f17e2a` (shared SSOT graph):

| Function | Role |
|----------|------|
| `scheduled-dispatch` | JIT monitor, arm_ack / ack_nro, timeout rescue |
| `schedule-dispatch` | Shared conversion / broadcast helpers |
| `scheduled-checkin` | Heading-to-pickup ack + deadline reject |
| `scheduled-ride-action` | Driver scheduled actions |
| `admin-scheduled-ride-action` | Admin emergency mutate (RBAC + financial gates) |
| `accept-offer` | Offer accept races with ack |
| `auto-dispatch` | Instant conversion path |
| `expire-offers` | Ack timeout / offer expiry sweep |
| `decline-trip` | Decline / cancel rematch |
| **`bind-driver-device-token`** | **Additional dependency** — persists `client_capabilities` / `app_version` for capability gate |

All listed function directories exist under `supabase/functions/`.

Post-deploy flags (until separate approval): keep **`jit_auto_activate_enabled=false`** and **`scheduled_departure_ack_enabled=false`**.

---

## 4. Admin publication target

- **App:** ONECAB Admin web (`admin-new`)
- **Branch / tip:** `release/scheduled-admin-monitoring-phase6` @ **`89f17e2a`**
- **Route:** existing `/scheduled-rides` (monitoring + Emergency RBAC)
- **Auto Dispatch:** unchanged (policy/config only)

---

## 5. Driver OTA runtime targets

| Platform | Package | App version | Runtime version | Store train |
|----------|---------|-------------|-----------------|-------------|
| iOS | `com.onecab.driver.app` | `1.0.6` | **`1.0.6(4)`** | buildNumber `4` |
| Android | `com.onecab.driver.app` | `1.0.6` | **`1.0.6(64)`** | versionCode `64` |

- **OTA tip:** Driver `0898190`  
- **Capability token:** `scheduled_departure_ack_v1` on `driver_active_devices.client_capabilities` (not `app_version` alone)  
- Older / non-capable Drivers: Phase 4 **ack-safe NRO** (`ack_nro`) when Phase 5 flag is later enabled — **never** direct activation without acknowledgement.

---

## 6. Existing test evidence (reused — not re-run)

| Area | Evidence |
|------|----------|
| Phase 4/5 SSOT, strict 45s, races, capability gate | Prior Phase 4/5 lock + PG / simulator harness; tips `71331048` / `a15e20d8` / `2041d9ad` |
| Phase 5 staging blockers | `docs/PHASE5_STAGING_BLOCKER_RESOLUTION_REPORT.md` — code-complete; notification matrix deferred |
| Phase 6 Admin locks | `adminScheduledRidePresentationLock` + `adminScheduledRideMonitoringLock` — **24/24** at Phase 6 close |
| Emergency RBAC map | Phase 3/6 locks → `scheduled_rides.*` via `admin-scheduled-ride-action` |
| Capability registration path | Staging claim with `scheduled_departure_ack_v1` (registration evidence; full notification matrix deferred) |

No new code-level defect found that requires re-running completed suites.

---

## 7. Production preflight checks (read-only — Owner window)

Before any mutate:

1. **Inventory (read-only):** active/scheduled trips, `scheduled_ack_status='pending'` count (expect 0 pre-enable), open offers, confirmed scheduled without `driver_id`.  
2. **Config (read-only):** confirm production dispatch + financial settings unchanged, including Milton Keynes **`enable_preauth_buffer=false`**, **`buffer_value=2`**.  
3. **Confirm flags remain false** after migrate/Edge: `jit_auto_activate_enabled`, `scheduled_departure_ack_enabled`.  
4. **Do not** create test bookings or payments.

---

## 8. Coordinated deployment sequence (execute only with final Owner approval)

1. Read-only preflight (§7).  
2. Confirm production dispatch/financial config (preserve list below).  
3. Guarded apply migrations 1→2→3.  
4. Keep **`jit_auto_activate_enabled=false`**.  
5. Keep **`scheduled_departure_ack_enabled=false`**.  
6. Deploy complete Edge manifest (§3) — backward-compatible with flags off.  
7. Publish Admin `89f17e2a`.  
8. Publish Driver OTA `0898190` to iOS `1.0.6(4)` + Android `1.0.6(64)` production channel.  
9. Verify sample online drivers show `scheduled_departure_ack_v1` on active-device rows.  
10. **Stop.** Enable Phase 5 (`scheduled_departure_ack_enabled=true`) **only** after explicit Owner approval; capability gate routes non-capable Drivers to NRO.  

**Do not** enable direct activation without acknowledgement (`jit_auto_activate_enabled` stays false unless separately approved).  
**Do not** disrupt in-flight active or scheduled bookings (flags off = no new Phase 5 arming).

---

## 9. Preserve production configuration (no changes in this RC)

- Payment-first booking creation  
- Revolut authorisation / capture coverage  
- 5-day max / 20-minute min advance  
- Capture coverage margin of six hours  
- Airport pricing + Custom Zones  
- Driver Wallet + Commission Wallet  
- Base commission + wave reductions  
- Six-minute instant dispatch + existing waves/timers  
- Scheduled stacking  
- Milton Keynes preauth buffer: **disabled**, value **2**

---

## 10. Rollback (drain-first)

Helper: `supabase/migrations/rollback/drain_scheduled_departure_ack_phase5.sql`

If Phase 5 must be disabled after enablement:

1. Set **`scheduled_departure_ack_enabled=false`** (stops new arming).  
2. **Do not** extend existing `scheduled_ack_deadline_at` values — let pending sessions complete or expire (CAS rejects late acks).  
3. Wait until **`scheduled_ack_status='pending'` count = 0**.  
4. Only then redeploy prior compatible Edge and/or apply column rollbacks.  
5. Restore prior Admin/Driver release if required.  

**Do not** reverse completed bookings or create duplicate assignments.  
Phase 6 Admin-only rollback: redeploy prior Admin web revision (no DB rollback).

---

## 11. Genuine unresolved code-level blockers

**None** for coordinated release preparation.

Operational holds (not code defects):
- Production deploy / OTA / flag enable await **explicit Owner approval**  
- Physical-device notification matrix remains **deferred**  
- Phase 5 runtime remains **flag-off** until OTA capability adoption is verified post-publish  

---

## Cross-refs

- `docs/PHASE45_PRODUCTION_RELEASE_MANIFEST.md`  
- `docs/PHASE456_COORDINATED_DEPLOYMENT_MANIFEST.md`  
- `docs/PHASE6_ADMIN_SCHEDULED_MONITORING.md`  
- `docs/PHASE7_RELEASE_VERIFICATION_PLAN.md`  
