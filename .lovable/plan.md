# Digital Finance Migration — Operational Reset

One-time controlled reset moving ONECAB to a 100% digital payment model. Historical audit data preserved; operational balances zeroed via ledger entries (not silent updates); legacy cash workflow retired for new trips.

Nothing runs until you approve.

---

## 1. Scope

**Zeroed (operational state):**
- `driver_wallets.balance_pence` → 0
- Outstanding recovery debt (derived from `driver_wallet_ledger` DEBT entries) → offset to 0
- Scheduled weekly payout amounts (pending `payout_items`) → voided
- Available cash-out (`driver_earning_settlement.eligible_for_payout` unallocated rows) → marked migrated
- Open `payout_batches` in `pending`/`queued` state → archived
- Orphaned `payout_items` (no `stripe_transfer_id`) → voided

**Preserved (audit — untouched):**
- `trips`, `payments`, `trip_finance`
- All `driver_wallet_ledger` historical rows (kept, not deleted)
- `driver_earning_settlement` rows already `paid` / with `stripe_transfer_id`
- `stripe_connect_payouts`, `driver_early_cashouts` completed rows
- `driver_statements`, `statement_runs`

---

## 2. Tables & Functions Affected

| Table | Action |
|---|---|
| `driver_wallet_ledger` | INSERT one `MIGRATION_RESET` row per driver (offsets current balance to 0). No UPDATE/DELETE. |
| `driver_wallets` | Cache row recomputed to 0 by existing aggregate trigger after ledger insert. |
| `payout_items` | UPDATE status → `voided_migration` where status IN (`pending`,`queued`,`authorized`) AND `stripe_transfer_id IS NULL`. |
| `payout_batches` | UPDATE status → `archived_migration` where status IN (`pending`,`queued`,`processing`) AND no successful children. |
| `payout_authorization` | UPDATE status → `cancelled_migration` where pending. |
| `driver_earning_settlement` | UPDATE `settlement_lifecycle_status` → `migrated_legacy` where unallocated & unpaid. |
| `driver_early_cashouts` | UPDATE status → `cancelled_migration` where status IN (`pending`,`processing`). |
| `admin_settings` | INSERT `finance_era = 'digital'`, `finance_era_started_at = now()`. |

**New:**
- Migration ledger type: `MIGRATION_RESET` (enum/text value in `driver_wallet_ledger.entry_type`).
- View `v_finance_era_legacy_cash` (read-only, filters ledger rows where `created_at < finance_era_started_at`).
- View `v_finance_era_digital` (from `finance_era_started_at` onward).

**Removed (permanent cleanup per user policy):**
- Cash-workflow debt-recovery paths in `record-financial-outcome` and `tripSettlement.ts` — the `DEBT_RECOVERY` branch is deleted, not gated. Card-only settlement remains.
- Legacy cash commission accrual code paths.

---

## 3. Edge Function / Script

Single admin-only edge function: `admin-digital-finance-migration`
- Requires `super_admin` role (JWT verified via `requireAdmin()`).
- Idempotent: guarded by `admin_settings.finance_era = 'digital'` — refuses to run twice.
- Wraps everything in a single transaction via `rpc('run_digital_finance_migration')`.
- Emits one audit row per driver in `admin_payment_audit`.

Frontend: `/finance-reconciliation` gets an **Era selector** (Legacy Cash / Digital) and a one-time "Run Digital Finance Migration" button (super_admin only, disabled once era = digital).

---

## 4. SQL (representative — full version generated at execution time)

```sql
-- 1. Mark era
INSERT INTO admin_settings(key, value)
VALUES ('finance_era','digital'), ('finance_era_started_at', now()::text)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- 2. Per-driver zeroing ledger entry
INSERT INTO driver_wallet_ledger
  (driver_id, entry_type, amount_pence, currency, description, metadata, created_at)
SELECT
  dw.driver_id,
  'MIGRATION_RESET',
  -dw.balance_pence,           -- offsets current balance exactly to 0
  dw.currency,
  'Digital Finance Migration – Operational reset for transition to 100% digital payments.',
  jsonb_build_object('prior_balance_pence', dw.balance_pence),
  now()
FROM driver_wallets dw
WHERE dw.balance_pence <> 0;

-- 3. Void orphaned payout items
UPDATE payout_items
SET status='voided_migration', updated_at=now()
WHERE status IN ('pending','queued','authorized')
  AND stripe_transfer_id IS NULL;

-- 4. Archive open batches
UPDATE payout_batches
SET status='archived_migration', updated_at=now()
WHERE status IN ('pending','queued','processing')
  AND NOT EXISTS (
    SELECT 1 FROM payout_items pi
    WHERE pi.batch_id = payout_batches.id AND pi.stripe_transfer_id IS NOT NULL
  );

-- 5. Cancel pending authorizations and early-cashouts
UPDATE payout_authorization SET status='cancelled_migration', updated_at=now()
WHERE status IN ('pending','authorized');

UPDATE driver_early_cashouts SET status='cancelled_migration', updated_at=now()
WHERE status IN ('pending','processing');

-- 6. Mark unallocated settlements as migrated
UPDATE driver_earning_settlement
SET settlement_lifecycle_status='migrated_legacy', updated_at=now()
WHERE allocated_to_payout = false
  AND settlement_status <> 'paid';
```

---

## 5. Expected Impact

For **every driver**, after run:
- `wallet_balance` = £0.00
- `recovery_debt` = £0.00
- `scheduled_weekly_transfer` = £0.00
- `available_cashout` = £0.00
- Stripe Connect balances **unchanged** (Stripe is external SSOT).
- Historical `driver_wallet_ledger` fully queryable; new "Legacy Cash Era" tab surfaces them.

New trips settle card-only: `Driver Net = Fare − Commission`; transfer = `MAX(0, Driver Net)`; no debt recovery path exists.

---

## 6. Rollback Plan

Because the migration only INSERTs one ledger row per driver and flips statuses to explicit `*_migration` values (never deletes), rollback is deterministic:

```sql
-- undo era flag
DELETE FROM admin_settings WHERE key IN ('finance_era','finance_era_started_at');
-- delete migration ledger entries (aggregate trigger restores wallet balances)
DELETE FROM driver_wallet_ledger WHERE entry_type='MIGRATION_RESET' AND created_at >= :era_started_at;
-- restore statuses
UPDATE payout_items SET status='pending' WHERE status='voided_migration' AND updated_at >= :era_started_at;
UPDATE payout_batches SET status='pending' WHERE status='archived_migration' AND updated_at >= :era_started_at;
UPDATE payout_authorization SET status='pending' WHERE status='cancelled_migration' AND updated_at >= :era_started_at;
UPDATE driver_early_cashouts SET status='pending' WHERE status='cancelled_migration' AND updated_at >= :era_started_at;
UPDATE driver_earning_settlement SET settlement_lifecycle_status=NULL WHERE settlement_lifecycle_status='migrated_legacy' AND updated_at >= :era_started_at;
```

A pre-flight snapshot (`pg_dump` of the affected tables filtered to the touched rows) is written to `/mnt/documents/digital-migration-snapshot-<timestamp>.sql` before the run for a hard restore option.

---

## 7. Execution Sequence (after your approval)

1. Migration: add `MIGRATION_RESET` ledger type, `finance_era` keys, `*_migration` status values, era views.
2. Deploy `admin-digital-finance-migration` edge function.
3. Delete legacy cash / debt-recovery code paths from settlement + record-financial-outcome (per cleanup policy).
4. Add Era selector + one-time run button on Financial Reconciliation.
5. You click **Run** in the admin UI when ready.

Awaiting approval to proceed.
