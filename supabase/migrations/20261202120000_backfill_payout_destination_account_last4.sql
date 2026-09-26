-- MK-260926: Driver Withdraw GET quote reads account_last4 for masked_account.
-- Older PROVIDER_VERIFIED rows (e.g. MK0007) stored last4 only on destination_last4,
-- so the executor quote failed isExecutorQuoteAuthorized (last4.length === 4) and
-- Withdraw stayed unavailable despite cleared balance + verified destination.
-- Keep both columns aligned going forward; updateHandler already writes both.

UPDATE public.driver_payout_destinations
SET account_last4 = right(regexp_replace(destination_last4, '\D', '', 'g'), 4),
    updated_at = now()
WHERE destination_last4 IS NOT NULL
  AND btrim(destination_last4) <> ''
  AND length(regexp_replace(destination_last4, '\D', '', 'g')) >= 4
  AND (
    account_last4 IS NULL
    OR btrim(account_last4) = ''
    OR length(regexp_replace(account_last4, '\D', '', 'g')) < 4
  );
