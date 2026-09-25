# Admin Driver Financial Review & Repair — rollback

## Scope of this change

- New Edge: `admin-driver-financial-repair`
- New SSOT: `driverFinancialReviewRepairSSOT`
- New migration: `20261129120000_driver_financial_review_repair.sql` (not applied)
- Admin UI: Review & repair panel + menu items on Driver Wallet Ledger

## Rollback (before migrate/deploy)

1. Revert / close this draft PR — no production effect.
2. Do **not** apply the migration.
3. Do **not** deploy the Edge function.

## Rollback (if migration was applied — only after explicit approval)

```sql
-- Destructive — only with repair-control approval
DROP TRIGGER IF EXISTS trg_driver_financial_repair_audit_append_only ON public.driver_financial_repair_audit;
DROP TRIGGER IF EXISTS trg_deny_client_driver_financial_repair_audit ON public.driver_financial_repair_audit;
DROP TRIGGER IF EXISTS trg_deny_client_driver_financial_repair_requests ON public.driver_financial_repair_requests;
DROP FUNCTION IF EXISTS public.deny_driver_financial_repair_audit_mutation();
DROP FUNCTION IF EXISTS public.deny_client_driver_financial_repair_mutate();
DROP TABLE IF EXISTS public.driver_financial_repair_audit;
DROP TABLE IF EXISTS public.driver_financial_repair_requests;
DROP INDEX IF EXISTS public.driver_wallet_ledger_financial_repair_idempotency_uidx;
```

Then remove Edge function deploy and Admin UI commit.

## Guarantees

- No Revolut / provider calls in this path
- No payout / scheduler invocation
- No direct unfreeze writes
- Operational pause untouched by repair
