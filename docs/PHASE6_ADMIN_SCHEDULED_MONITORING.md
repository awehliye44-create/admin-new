# Phase 6 — Admin Scheduled Rides monitoring

**Branch:** `release/scheduled-admin-monitoring-phase6`  
**Base:** Phase 5 tip `a15e20d8`  
**Production:** not deployed  

## Intent

Evolve Admin **Scheduled Rides** into a monitoring board for Phases 3–5:

- Surface lifecycle labels: Requested, Confirmed, JIT pending, Alert pending/acked/timeout, Searching, Needs attention, Terminal (Expired/Cancelled), Active pickup (when visible).
- Keep Make Available / Broadcast behind an **Emergency** menu (not routine).
- Do **not** invent a second dispatch engine or remove emergency mutate paths.

## First slice (this branch)

1. Extend `adminScheduledRidePresentation` with Phase 4/5 ack + JIT monitoring keys.
2. Select `scheduled_ack_status` / `scheduled_ack_deadline_at` / `scheduled_hold_reason`.
3. Group Broadcast + Make Available under **Emergency** in the row menu.
4. Replace Held KPI with **Needs attention** count.

## Explicit non-goals

- No production deploy from this branch without Owner approval  
- No Phase 5 flag enablement  
- No physical-device testing cycle  
