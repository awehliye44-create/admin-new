# Payout recovery deploy — 2026-10-13

Forward fixes for early cash-out fees, the payout Resume gate and stale payout
items, plus the driver profile name sync. Historical ledger corrections are
**not** applied (see "Pending").

## What is live

### Edge Functions

| Function | Version | Notes |
|---|---|---|
| cancel-trip | v714 | refuses to cancel a trip whose journey has completed |
| driver-withdraw | v109 | early cash-out invariant (gross = net + fee) |
| reconcile-submitted-driver-withdrawals | v79 | import map `supabase/functions/deno.json` |
| admin-execute-weekly-payout-occurrence | v127 | |
| admin-weekly-payout-scheduler | v219 | now also loads `_shared/weeklyPayoutPeriodSSOT.ts` and `_shared/economicEarnedAtSSOT.ts` |
| admin-finance-reconciliation | v292 | |

All six keep `verify_jwt = false`. `admin-finalize-driver-payout-completion`
bundles none of the changed files and was not redeployed.

### Database

| Change | How | Recorded as |
|---|---|---|
| `admin_settings.early_cashout_fee_pence` 0 → 50 | `_draft_review_only/20261216110000_early_cashout_fee_setting_50p.sql` | `payout_audit_log` `EARLY_CASHOUT_FEE_SETTING_ALIGNED` |
| CASHOUT_FEE row on completion, fee SSOT, stale item retirement | `20261216120000_payout_recovery_cashout_fee_partial_batch_stale_items.sql` | `schema_migrations` md5 `a09cfa51166f77816b6bb73dd5ea39fb` |
| Early cash-out invariant trigger, `fail_submitted_early_cashout`, audit view | `20261216140000_early_cashout_financial_invariant.sql` | md5 `d47746e699e96bf7c7fe8e5c8d7ede80` |
| Resume gate counts chargeable cancellation compensation, excludes held cancelled credits | `20261216160000_resume_gate_terminal_outcome_entitlement.sql` | md5 `d418f3c080e1f7dc2ec3017996f1b301` |
| `profiles.full_name` follows `drivers.first_name/last_name` | `20261216180000_sync_driver_profile_full_name.sql` | md5 `546c8f7c674598d90fd3a4f7992ec17a` |

Each md5 is `md5(statements[1])` in production and equals the committed file.
Rollbacks are in `supabase/migrations/rollback/`.

## Branches

- **`release/payout-recovery-prod-lineage`** (this branch) is the deploy source
  for the six functions. It starts from `release/wallet-readers-fr-lineage`
  (`0fca309c`), the lineage production was built from.
  - `28db9400` pins `cancel-trip/index.ts` and `_shared/tripTerminalDispatch.ts`
    to the blobs that were live before this deploy (payment-evidence port and
    the scheduled-cancel patch), so nothing live is rolled back.
  - The next commit is the payout recovery change itself.
- **`snapshot/production-edge-20261013-payout-recovery`** (`9f6422dc`) holds the
  six deployed bundles byte-for-byte, one folder per function, because some
  shared files differ between functions (below).
- **Not merged into `main`.** `origin/main` is 202 commits ahead of this lineage
  and 39 behind; much of it is not in production. Porting onto `main` is a
  separate, reviewed change.

## Shared files that differ per function (pre-existing)

Production functions were deployed at different times, so these files exist in
more than one version. A single source tree can hold only one; this branch keeps
the version noted, and the snapshot branch keeps every version.

| File | This branch matches | Other live version used by |
|---|---|---|
| `_shared/tripSettlement.ts` | cancel-trip, admin-finance-reconciliation | driver-withdraw, admin-execute-weekly-payout-occurrence, admin-weekly-payout-scheduler |
| `_shared/frDriverExpectedEntitlementSSOT.ts` | admin-finance-reconciliation | cancel-trip |
| `_shared/fetchDriverPayoutEligibility.ts` | admin-execute-weekly-payout-occurrence, admin-weekly-payout-scheduler, admin-finance-reconciliation | driver-withdraw |

Deploying one of those functions from this tree changes that file for it.
Either copy the live version from the snapshot into a per-function deploy tree,
or unify the file deliberately with review.

## Migration history

Production records 765 versions. No branch has a local migration that
production lacks, so nothing can be applied twice by a push.

- `origin/main` has every recorded version except `20261009035951` and the four
  above.
- This branch is older and lacks 26 recorded versions;
  `scripts/check-migration-history-vs-prod.sh` lists them.
- **`20261009035951`** (name `3f070f2e-5355-483f-9063-e936a0dff5ee`, recorded by
  awehliye44@gmail.com on 2026-10-09) grants and adds Company-admin policies on
  `public.corporate_policies`. It exists in no branch. Because of it,
  `supabase db push` refuses to run. Production history was **not** changed.

Bringing the repository in line needs approval and is one of:

1. Add a file `20261009035951_3f070f2e-5355-483f-9063-e936a0dff5ee.sql` holding
   the recorded SQL. Files only; nothing is re-applied.
2. `supabase migration repair` — rewrites production history; not without
   explicit approval.

## Rules for the next deployment

1. Do not run `supabase db push` or `supabase migration repair` against
   production while `check-migration-history-vs-prod.sh` reports remote-only
   versions, and never repair without approval.
2. Do not use the MCP `apply_migration` tool. It records the current time as
   the version, so a later push re-applies the file under its real version.
3. Apply each new migration with
   `scripts/build-guarded-migration-apply.py <file> > /tmp/apply.sql` then
   `supabase db query --linked -f /tmp/apply.sql`. It aborts if the version is
   already recorded, and records the file under its own version in the same
   transaction (`version` is the primary key, so a duplicate cannot commit).
4. Run `scripts/check-migration-history-vs-prod.sh <new versions>` before and
   after; it fails on any local-only version that was not named.
5. Before deploying any of these six functions, download the live bundle and
   run `scripts/verify-edge-function-against-tree.py` against the deploy tree.
   Deploy only when the differences are exactly the intended change. After
   deploying, verify the read-back the same way and refresh the snapshot.

## Pending — needs owner approval

- `_draft_review_only/20261216130000_payout_recovery_historical_corrections.sql`
  is **not applied**. It adds the four missing 50p CASHOUT_FEE rows and retires
  stale items. It refuses to run unless the fee SSOT is 50p and all four Revolut
  payments match. It is waiting on the owner's check of:
  - 16 Sep £32.69, `driver-payout:5f00ba74-9592-4438-9e42-a9ae9a368c6a`, payment `05609426-d06a-e322-0040-620084084902`
  - 18 Sep £11.29, `driver-payout:0e237504-4d22-4ce4-a93d-ee2c2bdce004`, payment `05610bd9-4e62-e3aa-0040-62ad77e04cd4`
- MK-260923-017's £4.30 stays held until verified.
- Every collected early cash-out fee is ONECAB revenue and must never remain in
  a driver wallet; `early_cashout_invariant_audit` lists any completion that
  breaks this (currently the four rows above).
- The revenue report change (`src/hooks/financeReconciliationApi.ts`,
  `src/pages/OnecabRevenueProfitReport.tsx`) is not deployed and not on this
  branch.

## Tests

On this branch, with the parent commit as baseline:

- Deno suites for payout, withdrawal, reconciliation and the workspace locks:
  421 passed. The 5 failures (`driverCancelPushNotifyLock`,
  `customerTripLifecycleNotifyLock`, `economicEarnedAtSSOT`) fail identically on
  `0fca309c`. `revolutHoldReleaseDefectLock` cannot load on this lineage.
- Vitest payout, pause/resume and commission wallet suites: 157 passed. The one
  failure (`phase3Batch3bAdminFinancialRpcAuthzLock`, a November rollback file)
  fails identically on `0fca309c`.
- `deno check`: no new errors in any of the six entrypoints.
