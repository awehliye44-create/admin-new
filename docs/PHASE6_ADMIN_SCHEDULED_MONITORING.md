# Phase 6 — Admin Scheduled Rides monitoring

**Branch:** `release/scheduled-admin-monitoring-phase6`  
**Base:** Phase 5 tip `a15e20d8` (+ Phase 6 first slice `963aacac`)  
**Production:** not deployed — Owner approval required  

## Intent

Complete Admin **`/scheduled-rides`** as the operational monitoring board for automatic scheduled bookings. Admin watches the backend workflow and intervenes only when required. Auto Dispatch remains policy/config only — no duplicated scheduled booking management.

## Delivered

### Presentation SSOT (`adminScheduledRidePresentation.ts`)

Lifecycle labels derived from authoritative trip columns only:

| State | Presentation |
|-------|----------------|
| Unpublished scheduled | Awaiting publication |
| Published marketplace | Requested |
| Confirmed / pre-confirm | Confirmed + `PRE-CONFIRMED` badge |
| JIT window | JIT pending |
| Ack armed (45s) | Awaiting departure ack |
| Ack success + en route | Heading to pickup |
| Ack success (pre-en-route) | Departure acknowledged |
| Ack timeout | Ack timeout |
| Rematch / search | Searching / Converted to instant |
| Payment / airport / exhaustion / exceptional hold | Needs attention / Payment blocked |
| Terminal | Expired / Cancelled |

**Hard rule:** never show Heading to pickup before successful departure acknowledgement.

**Needs attention:** only genuine ops exceptions via `resolveManualInterventionRequired` — not ordinary ack-pending windows, and not ack timeout while automatic rematch is already running.

### Monitoring helpers (`adminScheduledRideMonitoring.ts`)

- Ack countdown / deadline formatting  
- Payment + airport readiness (no card secrets / PANs)  
- Compatible-journey deferral cue  
- Workflow events derived from existing columns (publish, accept, JIT, arm, ack, timeout, exclusion, rematch, exhaustion)  
- Ops snapshot for details panel  

### Scheduled Rides page

- Extended select: ack / JIT / hold / payment_state / airport_charge / excluded drivers  
- Status column: lifecycle badge + optional Needs attention + live ack countdown  
- Details: automatic workflow panel (ETA, JIT deadline, ack countdown, readiness, events)  
- Filter: Needs attention  
- Emergency menu: Broadcast, Make Available, **Hold** (`hold_exceptional`), Cancel pending, Cancel Ride — all via existing `admin-scheduled-ride-action` + RBAC  

## Explicit non-goals

- No second event log / status store  
- No new Scheduled Rides page / Auto Dispatch duplicate  
- No payment / airport / wallet / commission / dispatch timer changes  
- No production deploy / OTA / flag flips without Owner approval  
- No physical-device / simulator retest in Phase 6  

## Targeted tests

```bash
npx vitest run \
  src/lib/__tests__/adminScheduledRidePresentationLock.test.ts \
  src/lib/__tests__/adminScheduledRideMonitoringLock.test.ts
```

## Migrations / Edge

**None new for Phase 6.** Depends on Phase 4–5 migrations + existing `admin-scheduled-ride-action` Edge + Roles & Permissions keys.
