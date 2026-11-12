# Phase 4–6 Coordinated Deployment Manifest

**Status:** Code-complete for Phases 4–6 (2026-11-12)  
**Does not authorise production deploy, OTA publish, or flag enablement.**

Physical-device notification matrix: **deferred** (Owner). Phase 5 flag stays **off** until OTA adoption gate.

---

## Tips

| Component | Branch | Tip SHA | Role |
|-----------|--------|---------|------|
| Backend Phase 4+5 | `release/scheduled-departure-ack-phase5` | `a15e20d8` | JIT + departure ack + capability gate |
| Backend Phase 6 | `release/scheduled-admin-monitoring-phase6` | `e9adb79e` | Admin monitoring (`d18e2804` feature + docs tip) |
| Driver Phase 5 | `release/scheduled-departure-ack-phase5` | `0898190` | Advertises `scheduled_departure_ack_v1` |
| Phase 4 base | `release/scheduled-jit-phase4` | `71331048` | JIT sticky deadline / exclusive activation |

Customer app: no Phase 5/6 OTA required for ack (backend/Driver).

---

## Migrations (order — unchanged from Phase 4/5)

1. `20270214120000_scheduled_jit_activation_phase4.sql`  
2. `20270215120000_scheduled_departure_ack_phase5.sql`  
3. `20270215130000_scheduled_departure_ack_capability_gate.sql`  

**Phase 6:** no new migrations.

Drain-first rollback helper: `supabase/migrations/rollback/drain_scheduled_departure_ack_phase5.sql`

---

## Edge Functions (same deploy window as Phase 4/5)

`scheduled-dispatch`, `schedule-dispatch`, `scheduled-checkin`, `expire-offers`, `accept-offer`, `auto-dispatch`, `decline-trip`, `bind-driver-device-token`, `admin-scheduled-ride-action` (+ shared graph as required).

Phase 6 Admin UI deploys with Admin web only — **no new Edge**.

Flags after Edge deploy (until separate approval):

- `scheduled_departure_ack_enabled = false`  
- `jit_auto_activate_enabled` — leave at current production policy  

---

## Recommended production sequence (Owner-approved only)

1. **Backend migrate** Phase 4 → 5 → capability gate (if not already).  
2. **Deploy Edge** set above; confirm flags remain fail-closed.  
3. **Driver OTA** tip `0898190` (or later with capability). Confirm `scheduled_departure_ack_v1` on sample active devices.  
4. **Admin web** deploy Phase 6 branch tip (monitoring board).  
5. **Separate approval:** enable `scheduled_departure_ack_enabled` only after OTA adoption.  
6. **Separate approval:** JIT auto-activate policy if changing.  

Phase 6 Admin can ship **before** flag-on — monitoring is read/presentation + existing emergency RPCs.

---

## Rollback

| Layer | Action |
|-------|--------|
| Phase 6 Admin UI | Redeploy previous Admin web revision — no DB rollback |
| Phase 5 ack | Set `scheduled_departure_ack_enabled=false` → drain pending acks → then Edge/column rollback |
| Phase 4 JIT | Do not casually disable mid-flight confirmed bookings; follow Phase 4 rollback notes |

Never serve pre-Phase-5 Edge while `scheduled_ack_status='pending'` rows remain.

---

## Financial / workflow protections (must remain)

Payment-first creation · Revolut auth/capture · 5-day / 20-minute booking windows · Airport + Custom Zones pricing · Driver/Commission wallets · rates · directional dispatch · compatible stacked journeys · strict 45s ack · 6-minute instant dispatch · Milton Keynes preauth buffer.

---

## Cross-refs

- `docs/PHASE45_PRODUCTION_RELEASE_MANIFEST.md`  
- `docs/PHASE6_ADMIN_SCHEDULED_MONITORING.md`  
- `docs/PHASE7_RELEASE_VERIFICATION_PLAN.md`  
