-- 1. Fix case mismatch in trip_finance
UPDATE trip_finance SET payment_method = 'CASH' WHERE payment_method = 'cash';

-- 2. Backfill trip_finance for 12 missing completed trips
SELECT public.ops_repair_missing_financials('bfa43ad2-d55c-4b31-94e6-95c9dc5b37cc'::uuid);
SELECT public.ops_repair_missing_financials('4ae9abed-b7fd-4119-a337-07a8e3f8ddb7'::uuid);
SELECT public.ops_repair_missing_financials('5972a0f1-1d5b-4ea2-ad02-5f07d0545ad8'::uuid);
SELECT public.ops_repair_missing_financials('6d2fbd58-94e3-4c4e-a879-500f4ddf5469'::uuid);
SELECT public.ops_repair_missing_financials('b35ef3ba-4011-4e31-8933-8240b99d302d'::uuid);
SELECT public.ops_repair_missing_financials('f1019c00-32ef-4248-8184-56a8a29a266c'::uuid);
SELECT public.ops_repair_missing_financials('f7e7e574-967a-4492-9b4f-b064ccb6bc61'::uuid);
SELECT public.ops_repair_missing_financials('ae95d7ad-2b30-45aa-8034-9c927c716536'::uuid);
SELECT public.ops_repair_missing_financials('333fb708-195a-42a0-ab28-df99cc96ff7b'::uuid);
SELECT public.ops_repair_missing_financials('64a620a4-03b7-4628-b0e1-33ee39e6baba'::uuid);
SELECT public.ops_repair_missing_financials('15043c37-a852-4e97-8087-f89f4a929439'::uuid);
SELECT public.ops_repair_missing_financials('ec4fcc1d-e826-4133-962b-4b72f8f1c214'::uuid);

-- 3. Backfill missing driver_ledger entries for 8 trips that exist in driver_wallet_ledger but not driver_ledger
-- For each, create CASH_COMMISSION_DEBT and COMPANY_COMMISSION entries
INSERT INTO driver_ledger (driver_id, trip_id, entry_type, amount_pence, currency_code, description)
SELECT 
  dwl.driver_id,
  dwl.related_trip_id,
  'CASH_COMMISSION_DEBT',
  dwl.amount_pence,
  COALESCE(dwl.currency, 'INR'),
  'Backfill: ' || dwl.description
FROM driver_wallet_ledger dwl
WHERE dwl.driver_id = 'd0d7cad6-5903-4910-9cad-96dcc3517918'
  AND dwl.type = 'CASH_COMMISSION_DEBT'
  AND dwl.related_trip_id NOT IN (
    SELECT trip_id FROM driver_ledger 
    WHERE driver_id = 'd0d7cad6-5903-4910-9cad-96dcc3517918' 
    AND entry_type = 'CASH_COMMISSION_DEBT'
  );

INSERT INTO driver_ledger (driver_id, trip_id, entry_type, amount_pence, currency_code, description)
SELECT 
  dwl.driver_id,
  dwl.related_trip_id,
  'COMPANY_COMMISSION',
  ABS(dwl.amount_pence),
  COALESCE(dwl.currency, 'INR'),
  'Backfill: Platform commission'
FROM driver_wallet_ledger dwl
WHERE dwl.driver_id = 'd0d7cad6-5903-4910-9cad-96dcc3517918'
  AND dwl.type = 'CASH_COMMISSION_DEBT'
  AND dwl.related_trip_id NOT IN (
    SELECT trip_id FROM driver_ledger 
    WHERE driver_id = 'd0d7cad6-5903-4910-9cad-96dcc3517918' 
    AND entry_type = 'COMPANY_COMMISSION'
  );

-- 4. Make the financial summary view case-insensitive to prevent future issues
CREATE OR REPLACE VIEW driver_financial_summary AS
WITH ledger_totals AS (
  SELECT dl.driver_id,
    COALESCE(sum(CASE WHEN dl.entry_type <> 'COMPANY_COMMISSION' THEN dl.amount_pence ELSE 0 END), 0) AS wallet_balance,
    COALESCE(sum(CASE WHEN dl.entry_type = 'TRIP_EARNING_NET' THEN dl.amount_pence ELSE 0 END), 0) AS card_net_credits,
    COALESCE(sum(CASE WHEN dl.entry_type = 'CASH_COMMISSION_DEBT' THEN abs(dl.amount_pence) ELSE 0 END), 0) AS cash_commission_debits,
    COALESCE(sum(CASE WHEN dl.entry_type = 'COMPANY_COMMISSION' THEN dl.amount_pence ELSE 0 END), 0) AS company_commission_total,
    COALESCE(sum(CASE WHEN dl.entry_type IN ('ADJUSTMENT', 'BONUS') THEN dl.amount_pence ELSE 0 END), 0) AS adjustments_total,
    COALESCE(sum(CASE WHEN dl.entry_type IN ('PAYOUT', 'EARLY_CASHOUT', 'WEEKLY_PAYOUT', 'MANUAL_PAYOUT') THEN abs(dl.amount_pence) ELSE 0 END), 0) AS total_payouts_sent,
    COALESCE(sum(CASE WHEN dl.entry_type = 'CASHOUT_FEE' THEN abs(dl.amount_pence) ELSE 0 END), 0) AS total_fees,
    COALESCE(sum(CASE WHEN dl.entry_type = 'TRIP_EARNING_NET' AND dl.created_at >= CURRENT_DATE THEN dl.amount_pence ELSE 0 END), 0) AS today_card_earnings,
    COALESCE(sum(CASE WHEN dl.entry_type = 'CASH_COMMISSION_DEBT' AND dl.created_at >= CURRENT_DATE THEN abs(dl.amount_pence) ELSE 0 END), 0) AS today_cash_commission,
    count(DISTINCT CASE WHEN dl.entry_type IN ('TRIP_EARNING_NET', 'CASH_COMMISSION_DEBT') THEN dl.trip_id ELSE NULL END)::integer AS completed_trips,
    count(DISTINCT CASE WHEN dl.entry_type = 'TRIP_EARNING_NET' THEN dl.trip_id ELSE NULL END)::integer AS card_trip_count,
    count(DISTINCT CASE WHEN dl.entry_type = 'CASH_COMMISSION_DEBT' THEN dl.trip_id ELSE NULL END)::integer AS cash_trip_count,
    count(DISTINCT CASE WHEN dl.entry_type IN ('TRIP_EARNING_NET', 'CASH_COMMISSION_DEBT') AND dl.created_at >= CURRENT_DATE THEN dl.trip_id ELSE NULL END)::integer AS today_trip_count
  FROM driver_ledger dl
  GROUP BY dl.driver_id
), trip_finance_totals AS (
  SELECT tf.driver_id,
    COALESCE(sum(tf.commissionable_subtotal_pence), 0) AS gross_trip_total,
    COALESCE(sum(CASE WHEN UPPER(tf.payment_method) <> 'CASH' THEN tf.commissionable_subtotal_pence ELSE 0 END), 0) AS card_gross_total,
    COALESCE(sum(CASE WHEN UPPER(tf.payment_method) <> 'CASH' THEN tf.platform_commission_pence ELSE 0 END), 0) AS card_commission_total,
    COALESCE(sum(CASE WHEN UPPER(tf.payment_method) = 'CASH' THEN tf.commissionable_subtotal_pence ELSE 0 END), 0) AS cash_gross_total,
    COALESCE(sum(CASE WHEN UPPER(tf.payment_method) = 'CASH' THEN tf.driver_net_before_tip_pence ELSE 0 END), 0) AS cash_net_earnings,
    COALESCE(sum(CASE WHEN tf.created_at >= CURRENT_DATE THEN tf.commissionable_subtotal_pence ELSE 0 END), 0) AS today_gross_earnings,
    COALESCE(sum(CASE WHEN UPPER(tf.payment_method) = 'CASH' AND tf.created_at >= CURRENT_DATE THEN tf.commissionable_subtotal_pence ELSE 0 END), 0) AS today_cash_earnings
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
  COALESCE(sa.currency_code, r.currency_code, 'GBP') AS currency_code,
  d.region_id,
  COALESCE(tft.gross_trip_total, 0) AS gross_trip_total,
  COALESCE(lt.completed_trips, 0) AS completed_trips,
  COALESCE(lt.card_net_credits, 0) AS card_net_credits,
  COALESCE(tft.card_gross_total, 0) AS card_gross_total,
  COALESCE(tft.card_commission_total, 0) AS card_commission_total,
  COALESCE(lt.card_trip_count, 0) AS card_trip_count,
  COALESCE(tft.cash_gross_total, 0) AS cash_gross_total,
  COALESCE(tft.cash_net_earnings, 0) AS cash_net_earnings,
  COALESCE(lt.cash_commission_debits, 0) AS cash_commission_debits,
  COALESCE(lt.cash_trip_count, 0) AS cash_trip_count,
  COALESCE(lt.company_commission_total, 0) AS company_commission_total,
  COALESCE(tft.today_gross_earnings, 0) AS today_gross_earnings,
  COALESCE(tft.today_cash_earnings, 0) AS today_cash_earnings,
  COALESCE(lt.today_card_earnings, 0) AS today_card_earnings,
  COALESCE(lt.today_trip_count, 0) AS today_trip_count,
  COALESCE(lt.adjustments_total, 0) AS adjustments_total,
  COALESCE(lt.total_payouts_sent, 0) AS total_payouts_sent,
  COALESCE(lt.total_fees, 0) AS total_fees,
  COALESCE(lt.wallet_balance, 0) AS wallet_balance,
  GREATEST(COALESCE(lt.wallet_balance, 0), 0) AS available_for_payout,
  GREATEST(-COALESCE(lt.wallet_balance, 0), 0) AS amount_owed_to_onecab
FROM drivers d
LEFT JOIN service_areas sa ON sa.id = d.service_area_id
LEFT JOIN regions r ON r.id = d.region_id
LEFT JOIN ledger_totals lt ON lt.driver_id = d.id
LEFT JOIN trip_finance_totals tft ON tft.driver_id = d.id;