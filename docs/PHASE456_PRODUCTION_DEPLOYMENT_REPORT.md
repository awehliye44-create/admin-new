# Phase 4–6 Production Deployment Report

**Date:** 2026-11-12  
**Authorisation:** Explicit Owner approval for coordinated production deployment  
**Phase 5 runtime:** `scheduled_departure_ack_enabled=false` (not enabled)  
**JIT auto-activate:** `jit_auto_activate_enabled=false`

---

## Release candidates deployed

| Surface | SHA |
|---------|-----|
| Admin + Backend RC | `89f17e2a` |
| Driver OTA | `0898190` (`0898190781c0e0dda740bf596e140bcaf42663cf`) |

Admin published via fast-forward of `main` → `89f17e2a` (GitHub Pages). Tag dispatch was blocked by `github-pages` environment protection; `main` push succeeded.

---

## Preflight (read-only)

| Check | Result |
|-------|--------|
| Active trips | 0 |
| Open scheduled bookings | 0 |
| Pending ride offers | 0 |
| Target migrations present | Missing (expected) |
| MK preauth buffer | `enable_preauth_buffer=false`, `buffer_value=2` |
| Dispatch | `max_advance_days=5`, `min_advance_time_minutes=20`, stacking on, base commission 10%, waves unchanged |

No deployment blocker.

---

## Migrations (guarded per-file apply)

Applied in order via `scripts/build-guarded-migration-apply.py` + `supabase db query --linked -f`:

1. `20270214120000` — scheduled JIT activation Phase 4  
2. `20270215120000` — departure ack Phase 5  
3. `20270215130000` — capability gate  

**Verified after apply:**

- All three versions recorded in `supabase_migrations.schema_migrations`  
- `jit_auto_activate_enabled=false`  
- `scheduled_departure_ack_enabled=false`  
- `scheduled_departure_ack_seconds=45`  
- `scheduled_departure_ack_grace_seconds=0`  
- `scheduled_departure_ack_capability_key=scheduled_departure_ack_v1`  

---

## Edge Functions

Deployed from `89f17e2a` with `--use-api` to `thazislrdkjpvvghtvzo`:

| Function | Version after deploy |
|----------|----------------------|
| scheduled-dispatch | 639 |
| schedule-dispatch | 380 |
| scheduled-checkin | 260 |
| scheduled-ride-action | 584 |
| admin-scheduled-ride-action | 2 |
| accept-offer | 549 |
| auto-dispatch | 749 |
| expire-offers | 652 |
| decline-trip | 454 |
| bind-driver-device-token | 206 |

Shared SSOT assets (ack / JIT / activation / capability) included in upload graph.

---

## Admin publication

- Workflow: Deploy Admin Panel run `43233648865` — **success**  
- Head SHA: `89f17e2a`  
- URL: https://adminonecab.net/  
- Verified lazy chunk `assets/ScheduledRides-BFxlbZRY.js` contains Phase 6 markers (`Needs attention`, `Awaiting departure ack`, `Automatic workflow`, `JIT pending`, `hold_exceptional`, …)

---

## Driver production OTA

| Platform | Runtime | Update group ID | Update ID | Commit |
|----------|---------|-----------------|-----------|--------|
| Android | `1.0.6(64)` | `062fade9-a5c6-4109-b530-df42aee2b9a4` | `01a1d013-3808-7d1e-842a-8e14d4a89bc2` | `0898190` |
| iOS | `1.0.6(4)` | `c173ba49-8211-45ac-aff1-0753b10ebf9a` | `01a1d014-22a1-74df-8cf7-88c672011509` | `0898190` |

Channel: **production**. No native builds published.

---

## Post-deploy verification

| Check | Result |
|-------|--------|
| Three migrations applied | Yes |
| Ten Edge functions redeployed | Yes (versions above) |
| Admin Pages | Built / success |
| Driver OTAs | Both published |
| Scheduled crons active | `scheduled-dispatch-every-minute`, `schedule-dispatch-every-minute`, `expire-offers-sweep`, … |
| MK buffer | still false / 2 |
| Waves / commission / advance windows | unchanged |
| Pending ack sessions | 0 |
| Active trips / open scheduled | 0 (no disruption observed) |
| `client_capabilities` column | present |
| Devices already advertising `scheduled_departure_ack_v1` | **0 / 11** active-device rows (expected — OTA not yet loaded by drivers) |

---

## Phase 5 activation boundary (unchanged)

- **Do not enable** `scheduled_departure_ack_enabled` until separate Owner approval after OTA adoption.  
- Phase 4 acknowledgement-safe NRO remains the live path while flag is false.  
- `jit_auto_activate_enabled` remains **false** (no direct activation without acknowledgement).

---

## Rollback (retained)

`supabase/migrations/rollback/drain_scheduled_departure_ack_phase5.sql`

1. Disable new ack arming (`scheduled_departure_ack_enabled=false`)  
2. Preserve pending deadlines  
3. Drain to pending count = 0  
4. Only then revert incompatible Edge  

---

## Notes

- Physical-device notification testing remains deferred.  
- OTA publication ≠ drivers have applied the update; capability registration will appear after Driver clients cold-start onto `0898190`.  
