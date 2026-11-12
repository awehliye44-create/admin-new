# Phase 3 — Automatic Scheduled Marketplace Publication

**Production deploy is NOT approved until explicit sign-off.**

## Intent

Remove routine Admin Make Available for valid scheduled bookings.
Reuse existing Make Available patch + `scheduled-dispatch` STEP 0 / STEP 0b.
No parallel dispatch engine. No wave/timing/payment policy changes.

## Root cause (locked)

CTAP / `buildMinimalTripInsertRow` creates `scheduled_status=admin_held` +
`scheduled_broadcast_at=NULL`. Driver Requested requires published status + due
broadcast_at. Only Admin Make Available (or late STEP 2 activation) opened it.

## Implementation (code)

| Piece | Role |
|---|---|
| `scheduledMarketplaceAutoPublishSSOT.ts` | Eligibility, classify, CAS Make Available |
| `bookingPostCommit.ts` | After fare enrich + `assertPaymentGate`, auto-publish + notify |
| `scheduled-dispatch` STEP 0 jobs | Payment gate + airport hold before Jobs At |
| `scheduled-dispatch` STEP 0b | Recovery sweep (no Admin session) |
| Hub `BookingForm` / corporate wallet-cash | Immediate `scheduled` + `broadcast_at=now` |
| `supabase/scripts/scheduled_marketplace_phase3_dry_run.sql` | Hold classification only |

Create stamp remains `admin_held` (Hard Rule #1 create). Publication is post-gate.

## Admin controls after Phase 3

| Control | Routine? | After Phase 3 |
|---|---|---|
| Make Available Now/At | Was routine | Emergency / override only — keep UI |
| Assign Now/At | Exceptional | Retain |
| Broadcast Now/At | Emergency | Retain (fix UI airport bypass separately) |
| Cancel pending | Retain | Retain |
| Cancel Ride | Retain | Retain |
| Manual Trip held | Exceptional | Recovery sweep skips `admin_manual` |

## Dry-run before any bulk publish

```bash
supabase db query --linked -f supabase/scripts/scheduled_marketplace_phase3_dry_run.sql
```

Do **not** mass-publish airport / payment / Manual Trip / pending Assign|Broadcast rows.

## Deploy order (when approved) — dependency-aware

See also `docs/SCHEDULED_MARKETPLACE_PHASE3_FINAL_SECURITY.md` (action RBAC + mutate lock).

1. Confirm tips on `release/scheduled-marketplace-phase3`
2. Dry-run classification (read-only) — script uses `scheduled_hold_reason`
3. **Guarded migration** `20270213120000_scheduled_marketplace_hold_reason.sql`
   (column + airport broadcast trigger + unknown_historical backfill)
4. **Guarded migration** `20270213130000_scheduled_marketplace_final_security.sql`
   (publication_exhausted + `admin_page_mutate` protected fields + Assign Now action RBAC)
   — **must land before or with Admin publish** so old Cancel/Assign mutate paths cannot bypass
5. **Edge deploy (all consumers of modified shared modules) in same window:**
   - `admin-scheduled-ride-action` (**required** — action RBAC + Assign Now + Cancel Ride)
   - `create-trip-after-payment` (bookingPostCommit / bookingSSOT / exhaustion alerts)
   - `scheduled-dispatch` (STEP 0/0b + jobs gates)
   - `schedule-dispatch` (shared conversion broadcast helper)
   - `scheduled-ride-action` (cancel rematch airport-safe)
   - `onecab-assistant` / `get-active-trip` / `restore-active-trip` only if
     shared import graph requires (verify with deploy inventory script)
6. **Admin GitHub Actions publish** (ScheduledRides + RolesPermissions + ManualTrip)
   — Owner must grant `scheduled_rides.*` actions to non-Owner roles that need emergencies
7. **Lovable / central-hub publish** (BookingForm + corporate BookRide held create)
8. Driver/Customer OTA: **not required** for marketplace open (backend)
9. Smoke: read-only staff denied; mutate RPC refuse; airport hold; Assign Now audit; exhaustion alert
10. Monitor accept / cancel-rematch / airport hold / ops_alerts

No dispatch/payment config changes. MK buffer remains `false` / `2`.

**Compatibility:** Older Admin bundles that still call `admin_page_mutate` for Cancel/Assign
will fail closed after step 4 (protected fields). Do not leave production on old Admin after
the mutate lock. Temporary gate: emergency UI already uses Edge — fails closed until Admin publish.

## Rollback

1. Stop Admin/hub publishes if needed; redeploy prior Admin + hub bundles
2. Redeploy previous Edge versions listed above
3. Apply `rollback/rollback_20270213130000_scheduled_marketplace_final_security.sql`
   (restores mutate + assign RPC; keeps Phase 3 hold column / airport trigger)
4. Optional: keep hold_reason column (additive); do not drop casually
5. Airport trigger rollback SQL only if required (preserve Phase 1/2 protections)
6. Leave already-published trips as-is

## Out of scope

- JIT activation, 45s urgent alert, acknowledgement timeout
- New Admin monitoring dashboard (Phase 6)
- Production migration apply / OTA / live config without separate approval
