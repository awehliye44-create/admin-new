# Phase 4 + Phase 5 — Coordinated Production Release Manifest

**Status:** Code-complete (2026-11-12)  
**Physical-device notification matrix:** **Deferred at Owner request** — not a code-complete blocker.  
**Phase 5 runtime flag:** remains **`scheduled_departure_ack_enabled = false`** until compatible Driver OTA adoption is verified.  
**Production deploy / OTA publish:** **requires explicit Owner approval** (this document does not authorise either).

---

## Approved tips (isolated branches)

| Component | Branch | SHA | Notes |
|-----------|--------|-----|-------|
| Backend (`admin-new`) | `release/scheduled-departure-ack-phase5` | `a15e20d8` | Includes Phase 4 + Phase 5 + capability gate + local simulator harness |
| Driver (`onecab-driver-native`) | `release/scheduled-departure-ack-phase5` | `0898190` | Advertises `scheduled_departure_ack_v1` on active-device bind |
| Phase 4 dependency | `release/scheduled-jit-phase4` | `71331048` | Already accepted; must be present before Phase 5 Edge |

Customer app: **no Phase 5 OTA required** for acknowledgement (customer tracking gate is backend/Edge).

---

## Migrations (all three — apply in order)

1. `20270214120000_scheduled_jit_activation_phase4.sql`
2. `20270215120000_scheduled_departure_ack_phase5.sql`
3. `20270215130000_scheduled_departure_ack_capability_gate.sql`

Rollback / drain:

- Drain-first helper: `supabase/migrations/rollback/drain_scheduled_departure_ack_phase5.sql`
- Column rollbacks only after **pending ack count = 0**

---

## Required Edge Functions (same deploy window)

Deploy these together (shared SSOT / runner imports):

| Function | Why |
|----------|-----|
| `scheduled-dispatch` | JIT monitor, arm_ack / ack_nro, timeout rescue STEP |
| `schedule-dispatch` | Shared conversion / broadcast helpers |
| `scheduled-checkin` | Heading to Pickup ack + deadline reject |
| `expire-offers` | Ack timeout / offer expiry sweep |
| `accept-offer` | Offer accept races with ack |
| `auto-dispatch` | Instant conversion path |
| `decline-trip` | Decline / cancel rematch paths |
| `bind-driver-device-token` | Persist `client_capabilities` + `app_version` on active device |
| `scheduled-ride-action` | Driver scheduled actions (if shared graph requires) |
| `admin-scheduled-ride-action` | Admin emergency mutate (unchanged financial guards) |

Both flags must stay **false** after Edge deploy until OTA adoption gate:

- `global_dispatch_settings.scheduled_departure_ack_enabled = false`
- `global_dispatch_settings.jit_auto_activate_enabled` — leave at current production policy (Phase 4); do not flip casually with Phase 5

---

## Driver OTA (capability-aware)

1. Publish Driver OTA from tip `0898190` (or later) to production channel **only after Owner approval**.
2. Capability token is **OTA JS** `scheduled_departure_ack_v1` on `driver_active_devices.client_capabilities` — **not** native `app_version` alone.
3. After OTA: confirm active-device rows show `scheduled_departure_ack_v1` for a sample of online drivers (Admin/SQL read-only).
4. **Only then** consider enabling `scheduled_departure_ack_enabled` (separate explicit approval).

Older / non-capable Drivers remain on Phase 4 exclusive **NRO** (`ack_nro`) when the flag is later enabled.

---

## Capability-aware rollout

| Driver state | Flag off | Flag on |
|--------------|----------|---------|
| Missing / empty capabilities | No arm_ack | `ack_nro` (Phase 4 NRO) |
| Has `scheduled_departure_ack_v1` | No arm_ack | `departure_ack` / arm 45s |
| `app_version` alone | Never grants | Never grants |

Evidence of registration path: physical QA device claim with `scheduled_departure_ack_v1` (Owner accepted; full notification matrix deferred).

---

## Rollback procedure (drain-first)

1. Set `scheduled_departure_ack_enabled = false` (stops new arms; does **not** extend existing deadlines).
2. Run drain helper / wait until `scheduled_ack_status = 'pending'` count is **0**.
3. Late acks after deadline remain rejected (`ACK_EXPIRED` / SSOT).
4. Only after pending = 0: optionally roll back Edge to pre-Phase-5 revision and/or apply column rollback migrations.
5. Never leave pre-Phase-5 Edge serving while pending ack rows still exist.

---

## Code-level invariant checklist (evidence)

| Invariant | Evidence |
|-----------|----------|
| Strict backend 45s ack (`grace=0`) | `scheduledDepartureAckSSOT` + PG integration |
| Atomic ack / cancel / timeout | PG race harness + expire/checkin paths |
| No duplicate driver assignment | PG concurrency PASS |
| Capability-aware older-app fallback | `scheduledDepartureAckCapabilitySSOT` (5) + Driver lock (2) |
| Compatible active / stacked protection | Phase 4 JIT SSOT (`deferForCompatibleActiveJourney`) |
| Directional dispatch prioritisation | Phase 4 directional ranking locks |
| Preserve trip id / fare / payment auth | Simulator E2E + payment gate in runner |
| Customer live tracking only after ack | Checkin / tracking gate SSOT (en_route after Heading to Pickup) |
| Auto instant conversion on cancel/timeout | Simulator E2E + expire-offers settle |
| Safe disable + drain-first | Drain helper + local drain drill |
| Finance / airport / wallet / commission / dispatch | Unchanged outside scheduled JIT/ack modules; no Stripe reintro |

**Genuine unresolved code defects:** none identified that block code-complete with flag off.  
**Deferred (Owner):** full physical notification matrix (fg/bg/locked/terminated/tap/audible).

---

## Explicit non-goals of this manifest

- Do **not** deploy production without Owner approval  
- Do **not** publish Driver OTA without Owner approval  
- Do **not** enable `scheduled_departure_ack_enabled` until OTA adoption verified  
- Do **not** require another physical-device agent cycle for code-complete  
- Phase 6 Admin monitoring proceeds on an **isolated** branch (separate from this release gate)
