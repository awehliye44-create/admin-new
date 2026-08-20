# Rollback: reconcile-submitted-driver-withdrawals

## What this function does
Scheduled poller that reconciles SUBMITTED EARLY_CASHOUT payout items whose
Revolut transfer has completed but whose local record was not finalised.
It is a **read + finalize-only** function — it never creates a new payment.

## Rollback procedure
1. In Supabase Dashboard → Edge Functions, select `reconcile-submitted-driver-withdrawals`
   and click **Pause** (disables invocations without deleting the function).
2. In Supabase Dashboard → Database → pg_cron, delete the job named
   `reconcile-submitted-driver-withdrawals-every-2m` (if it was added).
   ```sql
   SELECT cron.unschedule('reconcile-submitted-driver-withdrawals-every-2m');
   ```
3. If the function caused data issues (impossible given its design, but for completeness):
   - It only calls `finalize_driver_payout_completion` RPC, which is idempotent.
   - No financial state can be created that cannot be verified via payout_items + driver_wallet_ledger.
   - No Revolut payment is ever created.

## Deployment order (when approved)
1. Verify both existing reconciled items are in COMPLETED state (done ✓).
2. Deploy function only:
   ```
   supabase functions deploy reconcile-submitted-driver-withdrawals
   ```
3. Smoke-test with a dry_run POST (no mutations):
   ```bash
   curl -s -X POST \
     "https://<project-ref>.supabase.co/functions/v1/reconcile-submitted-driver-withdrawals" \
     -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
     -H "Content-Type: application/json" \
     -d '{"dry_run":true}'
   ```
   Expect: `{ "ok": true, "processed": 0, "dry_run": true }` (no SUBMITTED items currently).
4. When confident: add ONE pg_cron schedule (every 2 minutes):
   ```sql
   SELECT cron.schedule(
     'reconcile-submitted-driver-withdrawals-every-2m',
     '*/2 * * * *',
     $$
     SELECT net.http_post(
       url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url' LIMIT 1)
         || '/functions/v1/reconcile-submitted-driver-withdrawals',
       headers := jsonb_build_object(
         'Content-Type', 'application/json',
         'Authorization', 'Bearer ' || (
           SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key' LIMIT 1
         )
       ),
       body := '{}'::jsonb
     );
     $$
   );
   ```
5. Verify with a genuine pending→completed payout before trusting schedule at scale.
6. Deploy Driver UI fix (`walletAdapter.ts` + `WithdrawalDetailsScreen.tsx`) separately.

## Schema migration (before deploying)
The function attempts to update `reconcile_attempt_count`, `last_reconcile_at`,
`next_reconcile_at`, `last_reconcile_provider_state`, `last_reconcile_error` on
`driver_payout_payment_intents`. If these columns are absent, the meta update is
a no-op (wrapped in `.catch()`).

To add the columns:
```sql
ALTER TABLE driver_payout_payment_intents
  ADD COLUMN IF NOT EXISTS reconcile_attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_reconcile_at timestamptz,
  ADD COLUMN IF NOT EXISTS next_reconcile_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_reconcile_provider_state text,
  ADD COLUMN IF NOT EXISTS last_reconcile_error text;

CREATE INDEX IF NOT EXISTS idx_dppi_next_reconcile_at
  ON driver_payout_payment_intents (next_reconcile_at)
  WHERE financially_applied_at IS NULL;
```
This is optional but recommended for observability and back-off gating.

## Do not
- Add a second pg_cron schedule for the same function.
- Change the function to call `/pay` (Revolut payment creation).
- Use this function to process WEEKLY_PAYOUT or WEEKLY_SCHEDULED batches.
