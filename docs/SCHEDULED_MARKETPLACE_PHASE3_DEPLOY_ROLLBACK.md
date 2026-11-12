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

## Deploy order (when approved)

1. Confirm tips on `release/scheduled-marketplace-phase3`
2. Dry-run classification on production (read-only)
3. Deploy Edge: `create-trip-after-payment`, `scheduled-dispatch` (+ consumers if shared deps require)
4. Publish hub if BookingForm/BookRide changes are in scope
5. No Driver/Customer OTA required for core publish (backend opens Requested)
6. Smoke: CTAP scheduled → Requested without Admin login
7. Monitor first genuine accept / cancel-rematch / airport hold

No config changes. Preserve MK buffer `enable_preauth_buffer=false`, `buffer_value=2`.

## Rollback

1. Redeploy previous Edge versions of `create-trip-after-payment` + `scheduled-dispatch`
2. Hub: redeploy previous BookingForm/BookRide if published
3. Leave published trips as-is (safe)
4. Do **not** roll back Phase 1 financial protections or Phase 2 workflow fixes

## Out of scope

- JIT activation, 45s urgent alert, acknowledgement timeout
- New Admin monitoring dashboard (Phase 6)
- Production migration apply / OTA / live config without separate approval
