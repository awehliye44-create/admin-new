-- Fix driver_financial_summary view to use driver_wallet_ledger as the
-- single source of truth for wallet balance (matching the driver app).

CREATE OR REPLACE VIEW public.driver_financial_summary AS
WITH trip_totals AS (
  SELECT t.driver_id,
    COALESCE(sum(t.gross_fare_pence), 0::bigint) AS gross_trip_total,
    count(t.id)::integer AS completed_trips,
    COALESCE(sum(CASE WHEN t.payment_method <> 'cash' THEN t.driver_net_pence ELSE 0 END), 0::bigint) AS card_net_credits,
    COALESCE(sum(CASE WHEN t.payment_method <> 'cash' THEN t.gross_fare_pence ELSE 0 END), 0::bigint) AS card_gross_total,
    COALESCE(sum(CASE WHEN t.payment_method <> 'cash' THEN t.commission_pence ELSE 0 END), 0::bigint) AS card_commission_total,
    count(CASE WHEN t.payment_method <> 'cash' THEN 1 ELSE NULL END)::integer AS card_trip_count,
    COALESCE(sum(CASE WHEN t.payment_method = 'cash' THEN t.gross_fare_pence ELSE 0 END), 0::bigint) AS cash_gross_total,
    COALESCE(sum(CASE WHEN t.payment_method = 'cash' THEN t.driver_net_pence ELSE 0 END), 0::bigint) AS cash_net_earnings,
    COALESCE(sum(CASE WHEN t.payment_method = 'cash' THEN t.commission_pence ELSE 0 END), 0::bigint) AS cash_commission_debits,
    count(CASE WHEN t.payment_method = 'cash' THEN 1 ELSE NULL END)::integer AS cash_trip_count,
    COALESCE(sum(t.commission_pence), 0::bigint) AS company_commission_total,
    COALESCE(sum(CASE WHEN t.financial_outcome = 'COMPLETED' THEN t.gross_fare_pence ELSE 0 END), 0::bigint) AS completed_trip_revenue,
    COALESCE(sum(CASE WHEN t.financial_outcome = 'COMPLETED' THEN t.commission_pence ELSE 0 END), 0::bigint) AS completed_trip_commission,
    COALESCE(sum(CASE WHEN t.financial_outcome = 'NO_SHOW' THEN t.gross_fare_pence ELSE 0 END), 0::bigint) AS no_show_revenue,
    COALESCE(sum(CASE WHEN t.financial_outcome = 'NO_SHOW' THEN t.commission_pence ELSE 0 END), 0::bigint) AS no_show_commission,
    COALESCE(sum(CASE WHEN t.financial_outcome = 'LATE_PASSENGER_CANCELLATION' THEN t.gross_fare_pence ELSE 0 END), 0::bigint) AS late_cancel_revenue,
    COALESCE(sum(CASE WHEN t.financial_outcome = 'LATE_PASSENGER_CANCELLATION' THEN t.commission_pence ELSE 0 END), 0::bigint) AS late_cancel_commission,
    COALESCE(sum(CASE WHEN t.completed_at::date = CURRENT_DATE THEN t.gross_fare_pence ELSE 0 END), 0::bigint) AS today_gross_earnings,
    COALESCE(sum(CASE WHEN t.completed_at::date = CURRENT_DATE AND t.payment_method = 'cash' THEN t.gross_fare_pence ELSE 0 END), 0::bigint) AS today_cash_earnings,
    COALESCE(sum(CASE WHEN t.completed_at::date = CURRENT_DATE AND t.payment_method <> 'cash' THEN t.driver_net_pence ELSE 0 END), 0::bigint) AS today_card_earnings,
    count(CASE WHEN t.completed_at::date = CURRENT_DATE THEN 1 ELSE NULL END)::integer AS today_trip_count
  FROM trips t
  WHERE t.financial_outcome IN ('COMPLETED', 'NO_SHOW', 'LATE_PASSENGER_CANCELLATION')
    AND t.driver_id IS NOT NULL
  GROUP BY t.driver_id
),
wallet_totals AS (
  SELECT wl.driver_id,
    COALESCE(SUM(wl.amount_pence), 0::bigint) AS wallet_balance,
    COALESCE(SUM(CASE WHEN wl.type IN ('ADJUSTMENT', 'BONUS') THEN wl.amount_pence ELSE 0 END), 0::bigint) AS adjustments_total,
    COALESCE(SUM(CASE WHEN wl.type IN ('PAYOUT', 'EARLY_CASHOUT', 'WEEKLY_PAYOUT', 'MANUAL_PAYOUT') THEN ABS(wl.amount_pence) ELSE 0 END), 0::bigint) AS total_payouts_sent,
    COALESCE(SUM(CASE WHEN wl.type = 'CASHOUT_FEE' THEN ABS(wl.amount_pence) ELSE 0 END), 0::bigint) AS total_fees
  FROM driver_wallet_ledger wl
  GROUP BY wl.driver_id
),
payout_totals AS (
  SELECT pi.driver_id,
    COALESCE(sum(CASE WHEN pi.status = 'completed' THEN pi.amount_pence ELSE 0 END), 0::bigint) AS payouts_completed
  FROM payout_items pi
  GROUP BY pi.driver_id
)
SELECT d.id AS driver_id,
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
  COALESCE(tt.gross_trip_total, 0::bigint) AS gross_trip_total,
  COALESCE(tt.completed_trips, 0) AS completed_trips,
  COALESCE(tt.card_net_credits, 0::bigint) AS card_net_credits,
  COALESCE(tt.card_gross_total, 0::bigint) AS card_gross_total,
  COALESCE(tt.card_commission_total, 0::bigint) AS card_commission_total,
  COALESCE(tt.card_trip_count, 0) AS card_trip_count,
  COALESCE(tt.cash_gross_total, 0::bigint) AS cash_gross_total,
  COALESCE(tt.cash_net_earnings, 0::bigint) AS cash_net_earnings,
  COALESCE(tt.cash_commission_debits, 0::bigint) AS cash_commission_debits,
  COALESCE(tt.cash_trip_count, 0) AS cash_trip_count,
  COALESCE(tt.company_commission_total, 0::bigint) AS company_commission_total,
  COALESCE(tt.completed_trip_revenue, 0::bigint) AS completed_trip_revenue,
  COALESCE(tt.completed_trip_commission, 0::bigint) AS completed_trip_commission,
  COALESCE(tt.no_show_revenue, 0::bigint) AS no_show_revenue,
  COALESCE(tt.no_show_commission, 0::bigint) AS no_show_commission,
  COALESCE(tt.late_cancel_revenue, 0::bigint) AS late_cancel_revenue,
  COALESCE(tt.late_cancel_commission, 0::bigint) AS late_cancel_commission,
  COALESCE(tt.today_gross_earnings, 0::bigint) AS today_gross_earnings,
  COALESCE(tt.today_cash_earnings, 0::bigint) AS today_cash_earnings,
  COALESCE(tt.today_card_earnings, 0::bigint) AS today_card_earnings,
  COALESCE(tt.today_trip_count, 0) AS today_trip_count,
  COALESCE(wt.adjustments_total, 0::bigint) AS adjustments_total,
  GREATEST(COALESCE(wt.total_payouts_sent, 0::bigint), COALESCE(pt.payouts_completed, 0::bigint)) AS total_payouts_sent,
  COALESCE(wt.total_fees, 0::bigint) AS total_fees,
  COALESCE(wt.wallet_balance, 0::bigint) AS wallet_balance,
  GREATEST(COALESCE(wt.wallet_balance, 0::bigint), 0::bigint) AS available_for_payout,
  GREATEST(-COALESCE(wt.wallet_balance, 0::bigint), 0::bigint) AS amount_owed_to_onecab
FROM drivers d
  LEFT JOIN regions r ON r.id = d.region_id
  LEFT JOIN trip_totals tt ON tt.driver_id = d.id
  LEFT JOIN wallet_totals wt ON wt.driver_id = d.id
  LEFT JOIN payout_totals pt ON pt.driver_id = d.id;