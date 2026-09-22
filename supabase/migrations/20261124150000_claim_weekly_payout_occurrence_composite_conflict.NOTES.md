# Weekly occurrence claim composite ON CONFLICT

Incident: Tuesday 22 Sep 2026 cron job 67 invoked `admin-execute-weekly-payout-occurrence`. Claim failed before any occurrence row. No reservation, provider call, or wallet debit.

Classification (do not use SCHEDULER_NOT_INVOKED):

- SCHEDULER_INVOKED
- OCCURRENCE_CLAIM_FAILED
- PROVIDER_NOT_REACHED

## Provenance

`20260832010000_weekly_payout_orchestrator_claim_cron.sql` exists on `origin/main`, is present in remote `schema_migrations`, and is **not** parked. Version `20260832` is an intentional packed sequence after the `20260831*` slice migrations (August has no 32nd day). Do not rename it.

That migration created `UNIQUE (schedule_occurrence_key)` and `ON CONFLICT (schedule_occurrence_key)`. Live uniqueness is now the out-of-band composite index `uq_weekly_payout_occurrence_runs_key_dry (schedule_occurrence_key, dry_run)`. No later in-repo migration replaced `claim_weekly_payout_occurrence`. Re-applying `20260832010000` would not fix live.

## Intended identity

- Live: `(schedule_occurrence_key, dry_run=false)`
- Dry-run: `(schedule_occurrence_key, dry_run=true)`

This migration keeps the composite unique index and aligns `ON CONFLICT` + reuse `SELECT` to it.

## Edge closure

Cron invokes `admin-execute-weekly-payout-occurrence` (not Slice 5). Slice 5 `admin-weekly-payout-scheduler` only forwards when LIVE+TRANSPORT. Typed claim error mapping lives in the execute function + `weeklyPayoutOrchestratorSSOT`. SQL-only apply unblocks claim; execute deploy is required only for typed HTTP classification.

## Follow-on (do not apply yet)

`20261124160000` freezes `period_start` / `period_end` on the same claim row and
requires Edge eligibility to use that previous completed London week. Both
migrations ship on PR #62; neither is applied until period-scoped fix approval.

