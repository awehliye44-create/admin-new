-- Recreate driver_financial_summary to include all financially countable outcomes
-- (COMPLETED, NO_SHOW, LATE_PASSENGER_CANCELLATION)
DROP VIEW IF EXISTS public.driver_financial_summary;

CREATE VIEW public.driver_financial_summary AS
WITH trip_totals AS (
  SELECT
    t.driver_id,
    -- Total gross from all financially countable trips
    COALESCE(SUM(t.gross_fare_pence), 0) AS gross_trip_total,
    COUNT(t.id)::integer AS completed_trips,
    
    -- Card breakdown
    COALESCE(SUM(CASE WHEN t.payment_method <> 'cash' THEN t.driver_net_pence ELSE 0 END), 0) AS card_net_credits,
    COALESCE(SUM(CASE WHEN t.payment_method <> 'cash' THEN t.gross_fare_pence ELSE 0 END), 0) AS card_gross_total,
    COALESCE(SUM(CASE WHEN t.payment_method <> 'cash' THEN t.commission_pence ELSE 0 END), 0) AS card_commission_total,
    COUNT(CASE WHEN t.payment_method <> 'cash' THEN 1 END)::integer AS card_trip_count,
    
    -- Cash breakdown
    COALESCE(SUM(CASE WHEN t.payment_method = 'cash' THEN t.gross_fare_pence ELSE 0 END), 0) AS cash_gross_total,
    COALESCE(SUM(CASE WHEN t.payment_method = 'cash' THEN t.driver_net_pence ELSE 0 END), 0) AS cash_net_earnings,
    COALESCE(SUM(CASE WHEN t.payment_method = 'cash' THEN t.commission_pence ELSE 0 END), 0) AS cash_commission_debits,
    COUNT(CASE WHEN t.payment_method = 'cash' THEN 1 END)::integer AS cash_trip_count,
    
    -- Company total commission
    COALESCE(SUM(t.commission_pence), 0) AS company_commission_total,
    
    -- Revenue by type
    COALESCE(SUM(CASE WHEN t.financial_outcome = 'COMPLETED' THEN t.gross_fare_pence ELSE 0 END), 0) AS completed_trip_revenue,
    COALESCE(SUM(CASE WHEN t.financial_outcome = 'COMPLETED' THEN t.commission_pence ELSE 0 END), 0) AS completed_trip_commission,
    COALESCE(SUM(CASE WHEN t.financial_outcome = 'NO_SHOW' THEN t.gross_fare_pence ELSE 0 END), 0) AS no_show_revenue,
    COALESCE(SUM(CASE WHEN t.financial_outcome = 'NO_SHOW' THEN t.commission_pence ELSE 0 END), 0) AS no_show_commission,
    COALESCE(SUM(CASE WHEN t.financial_outcome = 'LATE_PASSENGER_CANCELLATION' THEN t.gross_fare_pence ELSE 0 END), 0) AS late_cancel_revenue,
    COALESCE(SUM(CASE WHEN t.financial_outcome = 'LATE_PASSENGER_CANCELLATION' THEN t.commission_pence ELSE 0 END), 0) AS late_cancel_commission,
    
    -- Today's earnings
    COALESCE(SUM(CASE WHEN t.completed_at::date = CURRENT_DATE THEN t.gross_fare_pence ELSE 0 END), 0) AS today_gross_earnings,
    COALESCE(SUM(CASE WHEN t.completed_at::date = CURRENT_DATE AND t.payment_method = 'cash' THEN t.gross_fare_pence ELSE 0 END), 0) AS today_cash_earnings,
    COALESCE(SUM(CASE WHEN t.completed_at::date = CURRENT_DATE AND t.payment_method <> 'cash' THEN t.driver_net_pence ELSE 0 END), 0) AS today_card_earnings,
    COUNT(CASE WHEN t.completed_at::date = CURRENT_DATE THEN 1 END)::integer AS today_trip_count
  FROM trips t
  WHERE t.financial_outcome IN ('COMPLETED', 'NO_SHOW', 'LATE_PASSENGER_CANCELLATION')
    AND t.driver_id IS NOT NULL
  GROUP BY t.driver_id
),
ledger_totals AS (
  SELECT
    dl.driver_id,
    COALESCE(SUM(CASE WHEN dl.entry_type IN ('ADJUSTMENT', 'BONUS') THEN dl.amount_pence ELSE 0 END), 0) AS adjustments_total,
    COALESCE(SUM(CASE WHEN dl.entry_type IN ('PAYOUT', 'EARLY_CASHOUT', 'WEEKLY_PAYOUT', 'MANUAL_PAYOUT') THEN ABS(dl.amount_pence) ELSE 0 END), 0) AS total_payouts_sent,
    COALESCE(SUM(CASE WHEN dl.entry_type = 'CASHOUT_FEE' THEN ABS(dl.amount_pence) ELSE 0 END), 0) AS total_fees
  FROM driver_ledger dl
  GROUP BY dl.driver_id
),
payout_totals AS (
  SELECT
    pi.driver_id,
    COALESCE(SUM(CASE WHEN pi.status = 'completed' THEN pi.amount_pence ELSE 0 END), 0) AS payouts_completed
  FROM payout_items pi
  GROUP BY pi.driver_id
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
  COALESCE(tt.gross_trip_total, 0) AS gross_trip_total,
  COALESCE(tt.completed_trips, 0) AS completed_trips,
  COALESCE(tt.card_net_credits, 0) AS card_net_credits,
  COALESCE(tt.card_gross_total, 0) AS card_gross_total,
  COALESCE(tt.card_commission_total, 0) AS card_commission_total,
  COALESCE(tt.card_trip_count, 0) AS card_trip_count,
  COALESCE(tt.cash_gross_total, 0) AS cash_gross_total,
  COALESCE(tt.cash_net_earnings, 0) AS cash_net_earnings,
  COALESCE(tt.cash_commission_debits, 0) AS cash_commission_debits,
  COALESCE(tt.cash_trip_count, 0) AS cash_trip_count,
  COALESCE(tt.company_commission_total, 0) AS company_commission_total,
  -- Revenue breakdown by type
  COALESCE(tt.completed_trip_revenue, 0) AS completed_trip_revenue,
  COALESCE(tt.completed_trip_commission, 0) AS completed_trip_commission,
  COALESCE(tt.no_show_revenue, 0) AS no_show_revenue,
  COALESCE(tt.no_show_commission, 0) AS no_show_commission,
  COALESCE(tt.late_cancel_revenue, 0) AS late_cancel_revenue,
  COALESCE(tt.late_cancel_commission, 0) AS late_cancel_commission,
  -- Today
  COALESCE(tt.today_gross_earnings, 0) AS today_gross_earnings,
  COALESCE(tt.today_cash_earnings, 0) AS today_cash_earnings,
  COALESCE(tt.today_card_earnings, 0) AS today_card_earnings,
  COALESCE(tt.today_trip_count, 0) AS today_trip_count,
  -- Ledger/wallet
  COALESCE(lt.adjustments_total, 0) AS adjustments_total,
  GREATEST(COALESCE(lt.total_payouts_sent, 0), COALESCE(pt.payouts_completed, 0)) AS total_payouts_sent,
  COALESCE(lt.total_fees, 0) AS total_fees,
  -- Wallet balance formula
  COALESCE(tt.card_net_credits, 0)
    - COALESCE(tt.cash_commission_debits, 0)
    - GREATEST(COALESCE(lt.total_payouts_sent, 0), COALESCE(pt.payouts_completed, 0))
    - COALESCE(lt.total_fees, 0)
    + COALESCE(lt.adjustments_total, 0) AS wallet_balance,
  GREATEST(
    COALESCE(tt.card_net_credits, 0)
      - COALESCE(tt.cash_commission_debits, 0)
      - GREATEST(COALESCE(lt.total_payouts_sent, 0), COALESCE(pt.payouts_completed, 0))
      - COALESCE(lt.total_fees, 0)
      + COALESCE(lt.adjustments_total, 0),
    0
  ) AS available_for_payout,
  GREATEST(
    -(COALESCE(tt.card_net_credits, 0)
      - COALESCE(tt.cash_commission_debits, 0)
      - GREATEST(COALESCE(lt.total_payouts_sent, 0), COALESCE(pt.payouts_completed, 0))
      - COALESCE(lt.total_fees, 0)
      + COALESCE(lt.adjustments_total, 0)),
    0
  ) AS amount_owed_to_onecab
FROM drivers d
LEFT JOIN trip_totals tt ON tt.driver_id = d.id
LEFT JOIN ledger_totals lt ON lt.driver_id = d.id
LEFT JOIN payout_totals pt ON pt.driver_id = d.id;