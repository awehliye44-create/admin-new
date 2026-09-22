# Weekly occurrence period scope

Incident occurrence: `weekly-payout:milton-keynes:2026-09-22T12:00:00+01:00`

Required period (Europe/London, exclusive end):

- `period_start` = 2026-09-14T00:00:00
- `period_end`   = 2026-09-21T00:00:00

## Why

Claim identity (`20261124150000`) unblocks INSERT. It does not freeze the earning week.
Live eligibility used `available_balance_pence` at execution `now()`, so a delayed
Tuesday tick could pay current-week credits that cleared after 12:00.

## This migration

- Adds immutable `period_start` / `period_end` on `weekly_payout_occurrence_runs`
- Derives the previous completed London calendar week from the occurrence key
- Stamps those bounds on first INSERT only; reuse returns the frozen row
- Does not create an occurrence, reserve, call Revolut, or write the wallet ledger

## Edge closure

`admin-execute-weekly-payout-occurrence` must filter ledger credits by the frozen
period using `economic_earned_at` (not clearing / execution time) and plan the
item amount as the sum of those unpaid rows. Frozen batch items are reused as-is.
Driver Withdraw is unchanged.

Cron 67 stays suspended until explicit approval after merge/apply/deploy.
