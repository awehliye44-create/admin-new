# Phase 7 — Final code-level release verification & coordinated deployment plan

**Status:** Verification complete — see `docs/PHASE7_PRODUCTION_READINESS_REPORT.md`  
**Admin RC tip:** `89f17e2a` · **Driver tip:** `0898190`  
**Scope:** Verification and deployment planning only.  
**Not in scope:** Physical-device testing, simulator retest loops, production deploy, OTA publish, or production configuration changes without explicit Owner approval.

---

## Objective

Confirm Phases 4–6 are still code-complete, mutually consistent, and ready for an Owner-approved coordinated rollout. Produce a go / no-go checklist — do not invent new product work.

---

## Inputs (reuse; do not re-audit from scratch)

| Artifact | Use |
|----------|-----|
| `docs/PHASE45_PRODUCTION_RELEASE_MANIFEST.md` | Phase 4/5 tips, migrations, Edge, flags, rollback |
| `docs/PHASE456_COORDINATED_DEPLOYMENT_MANIFEST.md` | Combined deploy order including Admin Phase 6 |
| `docs/PHASE6_ADMIN_SCHEDULED_MONITORING.md` | Admin monitoring surface |
| Phase 1–5 lock / SSOT tests already green | Regression baseline |
| Phase 6 locks | Presentation + monitoring + RBAC map |

---

## Code-level verification checklist

### A. Branch / tip consistency

- [ ] Backend Phase 6 tip includes Phase 5 tip ancestry (`a15e20d8` or equivalent)  
- [ ] Driver Phase 5 tip `0898190` still advertises `scheduled_departure_ack_v1`  
- [ ] No unrelated / deferred trip-capture work on release branches  

### B. Migrations & Edge (read-only verify)

- [ ] Three Phase 4/5 migrations present; **no unexpected Phase 6 migration**  
- [ ] Edge function set matches Phase 4/5 manifest  
- [ ] `admin-scheduled-ride-action` still maps Emergency actions → `scheduled_rides.*` permissions  

### C. Targeted automated tests (run once)

```bash
# Phase 6 Admin
npx vitest run \
  src/lib/__tests__/adminScheduledRidePresentationLock.test.ts \
  src/lib/__tests__/adminScheduledRideMonitoringLock.test.ts

# Sample Phase 4/5 SSOT (reuse existing; do not expand matrix)
# scheduledDepartureAck* / scheduledConfirmedActivation* / capability gate locks
```

- [ ] Heading-to-pickup never presented before ack  
- [ ] Needs-attention excludes ordinary rematch recovery  
- [ ] Emergency permission map intact  

### D. Flag / OTA gates (config checklist only)

- [ ] `scheduled_departure_ack_enabled` planned default **false** post-deploy  
- [ ] Driver OTA adoption plan documented before any flag-on request  
- [ ] Milton Keynes preauth buffer / dispatch timers untouched  

### E. Admin monitoring smoke (optional staging Admin web — no device matrix)

- [ ] `/scheduled-rides` loads; lifecycle badges distinguishable  
- [ ] Details show JIT / ack countdown / readiness / events  
- [ ] Emergency Hold / Make Available / Broadcast / Cancel still gated by RBAC  

---

## Coordinated deployment plan (execute only with Owner approval)

1. Migrate Phase 4 → 5 → capability gate (if not live).  
2. Deploy Edge package; keep ack flag **false**.  
3. Publish Driver OTA (`0898190`+); sample-check capabilities.  
4. Deploy Admin web (Phase 6 tip).  
5. **Stop.** Request separate approvals for:  
   - `scheduled_departure_ack_enabled=true`  
   - any JIT auto-activate policy change  
6. Post-enable: monitor Needs attention KPI + pending-ack drain metrics (ops).  

Rollback: see `PHASE456_COORDINATED_DEPLOYMENT_MANIFEST.md`.

---

## Exit criteria for Phase 7

- Checklist A–D complete with recorded SHAs  
- No new migrations required for Phase 6  
- Owner has a single deploy/rollback runbook spanning Phases 4–6  
- Explicit statement: **not deployed** until Owner approves  

Phase 7 does **not** repeat physical notification testing.
