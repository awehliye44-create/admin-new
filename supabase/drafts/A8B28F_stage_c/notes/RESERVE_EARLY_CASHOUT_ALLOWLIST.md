# Reserve EARLY_CASHOUT allow-list correction

## Incident

- `driver-withdraw` v33 created `EARLY_CASHOUT` batch/item then `reserve_driver_payout_item` returned `BATCH_NOT_ELIGIBLE`.
- Live kind gate (post Stage C / sibling rewrite) effectively allowed **only** `WEEKLY_SCHEDULED`.
- Money moved: NO. Reservation: 0. Provider: 0.
- Residue: batch `28d09598…` / item `4b93d6f9…` VALIDATED 3319/3269 / idempotency `driver-withdraw:c40dd8a6-…:wd_mu4h4rbq_r3xe2kxm`.

## Root cause

`20260814120000` added `EARLY_CASHOUT` to the allow-list. Later rewrites (`20260901150000`, `20261109470000`) replaced the function without preserving `EARLY_CASHOUT`.

## Fix (prepared, not applied)

- Forward: `20261112200000_reserve_driver_payout_item_early_cashout_allowlist.sql`
- Rollback: `rollback/rollback_20261112200000_…` (fail-closed if EARLY in flight)
- Allow-list: `WEEKLY_SCHEDULED` + `EARLY_CASHOUT` only

## EARLY_CASHOUT call graph

1. Edge `driver-withdraw` POST → quote/eligibility → insert `payout_batches(kind=EARLY_CASHOUT)` + `payout_items(VALIDATED)`
2. `persistPayoutItemLedgerAllocations` / lineage
3. RPC `reserve_driver_payout_item` ← **kind gate fixed here**
4. Company balance gate → Revolut `/pay` (provider) only after reserve ok
5. `finalize_driver_payout_submission` / `finalize_driver_payout_completion` / reconcile

Downstream RPCs already map `EARLY_CASHOUT` via `payout_batch_kind_to_ledger_type` (live HAS_EARLY=true). No second allow-list regression found on submit/finalize/reconcile kind checks.

## Residue plan

**Preferred:** after migration + corrected `driver-withdraw` redeploy, reuse same idempotency key — Edge already reuses in-flight EARLY item. Recompute quote; if gross/fee/net/dest still match, reserve the existing VALIDATED item.

**If stale / unsafe:** terminal FAILED/CANCELLED with reason `RESERVATION_KIND_NOT_SUPPORTED_AT_ATTEMPT` (Ahmed approval required). Do not delete rows.

## Containment note (Phase 0)

Exact v31 ezbr `9763f979…` could not be reproduced from preserved Aug-21 workdir (redeploy → v34 / `60cf84d1…`). STOPPED improvisation. Live currently POST-only GET 405 (Withdraw disabled on vc40) but **not** recorded v31 identity.

## Flags

`EARLY_CASHOUT_RPC_ALLOWLIST_CORRECT` (prepared)  
`WEEKLY_RESERVATION_UNCHANGED`  
`ORPHAN_RESOLUTION_PLANNED`  
`GROUP2_WITHHELD`  
`MIGRATION_PREPARED_NOT_APPLIED`  
`NO_PAYOUT_RELEASE` / `NO_PROVIDER_CALL` / `NO_NEW_RESERVATION` / `NO_WALLET_WRITE`
