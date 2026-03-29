
-- =================================================================
-- SINGLE SOURCE OF TRUTH: driver_ledger for ALL financial data
-- =================================================================

-- Step 1: Add new entry types to the check constraint
ALTER TABLE driver_ledger DROP CONSTRAINT driver_ledger_entry_type_check;
ALTER TABLE driver_ledger ADD CONSTRAINT driver_ledger_entry_type_check 
  CHECK (entry_type = ANY (ARRAY[
    'CASH_COMMISSION_DEBT',
    'TRIP_EARNING_NET',
    'PAYOUT',
    'EARLY_CASHOUT',
    'WEEKLY_PAYOUT',
    'MANUAL_PAYOUT',
    'CASHOUT_FEE',
    'ADJUSTMENT',
    'BONUS',
    'DEBT_RECOVERY',
    'REFUND_DEBIT',
    'COMPANY_COMMISSION',
    'TIP_CREDIT'
  ]));

-- Step 2: Backfill COMPANY_COMMISSION entries from existing CASH_COMMISSION_DEBT
INSERT INTO driver_ledger (driver_id, trip_id, entry_type, amount_pence, currency_code, description, created_at)
SELECT 
  dl.driver_id,
  dl.trip_id,
  'COMPANY_COMMISSION',
  ABS(dl.amount_pence),
  dl.currency_code,
  'Platform commission from cash trip',
  dl.created_at
FROM driver_ledger dl
WHERE dl.entry_type = 'CASH_COMMISSION_DEBT'
  AND NOT EXISTS (
    SELECT 1 FROM driver_ledger dl2 
    WHERE dl2.trip_id = dl.trip_id 
    AND dl2.entry_type = 'COMPANY_COMMISSION'
  );

-- Step 3: Rebuild driver_financial_summary view
DROP VIEW IF EXISTS public.driver_financial_summary;

CREATE VIEW public.driver_financial_summary
WITH (security_invoker = on) AS

WITH ledger_totals AS (
  SELECT 
    dl.driver_id,
    COALESCE(SUM(dl.amount_pence), 0) AS wallet_balance,
    COALESCE(SUM(CASE WHEN dl.entry_type = 'TRIP_EARNING_NET' THEN dl.amount_pence ELSE 0 END), 0) AS card_net_credits,
    COALESCE(SUM(CASE WHEN dl.entry_type = 'CASH_COMMISSION_DEBT' THEN ABS(dl.amount_pence) ELSE 0 END), 0) AS cash_commission_debits,
    COALESCE(SUM(CASE WHEN dl.entry_type = 'COMPANY_COMMISSION' THEN dl.amount_pence ELSE 0 END), 0) AS company_commission_total,
    COALESCE(SUM(CASE WHEN dl.entry_type IN ('ADJUSTMENT', 'BONUS') THEN dl.amount_pence ELSE 0 END), 0) AS adjustments_total,
    COALESCE(SUM(CASE WHEN dl.entry_type IN ('PAYOUT', 'EARLY_CASHOUT', 'WEEKLY_PAYOUT', 'MANUAL_PAYOUT') THEN ABS(dl.amount_pence) ELSE 0 END), 0) AS total_payouts_sent,
    COALESCE(SUM(CASE WHEN dl.entry_type = 'CASHOUT_FEE' THEN ABS(dl.amount_pence) ELSE 0 END), 0) AS total_fees,
    COALESCE(SUM(CASE WHEN dl.entry_type = 'TRIP_EARNING_NET' AND dl.created_at::date = CURRENT_DATE THEN dl.amount_pence ELSE 0 END), 0) AS today_card_earnings,
    COALESCE(SUM(CASE WHEN dl.entry_type = 'CASH_COMMISSION_DEBT' AND dl.created_at::date = CURRENT_DATE THEN ABS(dl.amount_pence) ELSE 0 END), 0) AS today_cash_commission,
    COUNT(DISTINCT CASE WHEN dl.entry_type IN ('TRIP_EARNING_NET', 'CASH_COMMISSION_DEBT') THEN dl.trip_id END)::integer AS completed_trips,
    COUNT(DISTINCT CASE WHEN dl.entry_type = 'TRIP_EARNING_NET' THEN dl.trip_id END)::integer AS card_trip_count,
    COUNT(DISTINCT CASE WHEN dl.entry_type = 'CASH_COMMISSION_DEBT' THEN dl.trip_id END)::integer AS cash_trip_count,
    COUNT(DISTINCT CASE WHEN dl.entry_type IN ('TRIP_EARNING_NET', 'CASH_COMMISSION_DEBT') AND dl.created_at::date = CURRENT_DATE THEN dl.trip_id END)::integer AS today_trip_count
  FROM driver_ledger dl
  GROUP BY dl.driver_id
),

trip_finance_totals AS (
  SELECT 
    tf.driver_id,
    COALESCE(SUM(tf.commissionable_subtotal_pence), 0) AS gross_trip_total,
    COALESCE(SUM(CASE WHEN tf.payment_method != 'CASH' THEN tf.commissionable_subtotal_pence ELSE 0 END), 0) AS card_gross_total,
    COALESCE(SUM(CASE WHEN tf.payment_method != 'CASH' THEN tf.platform_commission_pence ELSE 0 END), 0) AS card_commission_total,
    COALESCE(SUM(CASE WHEN tf.payment_method = 'CASH' THEN tf.commissionable_subtotal_pence ELSE 0 END), 0) AS cash_gross_total,
    COALESCE(SUM(CASE WHEN tf.payment_method = 'CASH' THEN tf.driver_net_before_tip_pence ELSE 0 END), 0) AS cash_net_earnings,
    COALESCE(SUM(CASE WHEN tf.created_at::date = CURRENT_DATE THEN tf.commissionable_subtotal_pence ELSE 0 END), 0) AS today_gross_earnings,
    COALESCE(SUM(CASE WHEN tf.created_at::date = CURRENT_DATE AND tf.payment_method = 'CASH' THEN tf.commissionable_subtotal_pence ELSE 0 END), 0) AS today_cash_earnings
  FROM trip_finance tf
  WHERE tf.is_financially_countable = true
  GROUP BY tf.driver_id
)

SELECT 
  d.id AS driver_id,
  d.first_name,
  d.last_name,
  d.email,
  d.phone,
  d.is_online,
  d.rating,
  d.approval_status,
  d.stripe_account_id,
  d.payouts_enabled,
  d.onboarding_complete,
  r.currency_code,
  d.region_id,
  COALESCE(tft.gross_trip_total, 0::bigint) AS gross_trip_total,
  COALESCE(lt.completed_trips, 0) AS completed_trips,
  COALESCE(lt.card_net_credits, 0::bigint) AS card_net_credits,
  COALESCE(tft.card_gross_total, 0::bigint) AS card_gross_total,
  COALESCE(tft.card_commission_total, 0::bigint) AS card_commission_total,
  COALESCE(lt.card_trip_count, 0) AS card_trip_count,
  COALESCE(tft.cash_gross_total, 0::bigint) AS cash_gross_total,
  COALESCE(tft.cash_net_earnings, 0::bigint) AS cash_net_earnings,
  COALESCE(lt.cash_commission_debits, 0::bigint) AS cash_commission_debits,
  COALESCE(lt.cash_trip_count, 0) AS cash_trip_count,
  COALESCE(lt.company_commission_total, 0::bigint) AS company_commission_total,
  COALESCE(tft.today_gross_earnings, 0::bigint) AS today_gross_earnings,
  COALESCE(tft.today_cash_earnings, 0::bigint) AS today_cash_earnings,
  COALESCE(lt.today_card_earnings, 0::bigint) AS today_card_earnings,
  COALESCE(lt.today_trip_count, 0) AS today_trip_count,
  COALESCE(lt.adjustments_total, 0::bigint) AS adjustments_total,
  COALESCE(lt.total_payouts_sent, 0::bigint) AS total_payouts_sent,
  COALESCE(lt.total_fees, 0::bigint) AS total_fees,
  COALESCE(lt.wallet_balance, 0::bigint) AS wallet_balance,
  GREATEST(COALESCE(lt.wallet_balance, 0::bigint), 0::bigint) AS available_for_payout,
  GREATEST(-COALESCE(lt.wallet_balance, 0::bigint), 0::bigint) AS amount_owed_to_onecab
FROM drivers d
LEFT JOIN regions r ON r.id = d.region_id
LEFT JOIN ledger_totals lt ON lt.driver_id = d.id
LEFT JOIN trip_finance_totals tft ON tft.driver_id = d.id;

GRANT SELECT ON public.driver_financial_summary TO authenticated;
GRANT SELECT ON public.driver_financial_summary TO anon;
