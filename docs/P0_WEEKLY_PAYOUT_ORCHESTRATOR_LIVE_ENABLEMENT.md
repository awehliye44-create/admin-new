# Weekly payout orchestrator — LIVE enablement (follow-up)

Do **not** set `LIVE_PAYOUT_EXECUTION_ENABLED=true` until all of the following are done.

## Already shipped

- Edge: `admin-execute-weekly-payout-occurrence`
- Cron `weekly-payout-scheduler` (`*/15`) invokes the orchestrator
- With `LIVE=false` + `TRANSPORT=true`: plans batch, funding check, destinations; stops with **`LIVE_PAYOUT_ROLLOUT_DISABLED`** (no reserve / no Revolut / no debit)
- Dry-run body: `{ "dry_run": true, "force": true, "force_schedule_occurrence_key": "weekly-payout:milton-keynes:2026-07-21T12:00:00+01:00" }`
- Gap close (planning):
  - relay allows validated `/pay` when `TRANSPORT=true` even if `LIVE=true`
  - Slice 7/8 admin retries no longer forbid LIVE
  - blocked planning statuses do not permanently conflict drivers
  - dry-run claims isolated from production claims `(occurrence_key, dry_run)`
- Gap close (money path — required before LIVE):
  - planning-blocked batches use `BLOCKED_EXECUTION_DISABLED` (Slice 6–reservable)
  - LIVE entry promotes items `CREATED`/`BLOCKED_EXECUTION_DISABLED` → `VALIDATED` and batch → `ITEMS_CREATED`
  - unfinished provider/reconcile items leave occurrence `RUNNING` with `money_path_executed=false` so later cron ticks reconcile without re-paying
  - already-submitted items poll + finalize only

## Before LIVE=true

1. Deploy updated Revolut relay (must not refuse `LIVE=true`). Do **not** use older Slice 7/12 install scripts that force `LIVE=false` and refuse LIVE=true hosts after you intentionally enable LIVE.
2. Confirm migration `20260832020000_weekly_payout_occurrence_dry_run_isolation.sql` is applied.
3. Review dry-run proof JSON (Ahmed £31.49, Bosteyo £14.74, total £46.23, funding SUFFICIENT vs Revolut source ~£56.03, verified recipients, idempotency keys, planned ledger effects).
4. Run a **controlled low-value** live test (single item or admin Slice 7→8) and confirm:
   - no duplicate Revolut payment
   - no duplicate `WEEKLY_PAYOUT` debit
   - reservation release on safe failure
   - unknown/timeout leaves reconcile state (no debit/release)
   - later cron tick finalizes `PROVIDER_ACCEPTED` without admin Mark paid
5. Explicitly set secret **and** relay env: `LIVE_PAYOUT_EXECUTION_ENABLED=true` (keep `REVOLUT_PAYMENT_TRANSPORT_ENABLED=true`).
6. Confirm next Tuesday 12:00 Europe/London tick completes: batch → reserve → submit → finalize → wallet + UI **without** admin Reserve/Submit.

## PASS criteria

**AUTOMATIC WEEKLY PAYOUT PASS** only when the Tuesday scheduler completes the full path **without** admin Reserve/Submit clicks.
