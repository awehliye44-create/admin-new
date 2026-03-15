-- Drop old view that was inconsistent
DROP VIEW IF EXISTS public.driver_wallet_balance;

-- Create unified financial summary view: single source of truth
CREATE OR REPLACE VIEW public.driver_financial_summary AS
WITH trip_totals AS (
  SELECT
    t.driver_id,
    COALESCE(SUM(t.gross_fare_pence), 0)::bigint AS gross_trip_total,
    COUNT(t.id)::int AS completed_trips,
    COALESCE(SUM(CASE WHEN t.payment_method != 'cash' THEN t.driver_net_pence ELSE 0 END), 0)::bigint AS card_net_credits,
    COALESCE(SUM(CASE WHEN t.payment_method != 'cash' THEN t.gross_fare_pence ELSE 0 END), 0)::bigint AS card_gross_total,
    COALESCE(SUM(CASE WHEN t.payment_method != 'cash' THEN t.commission_pence ELSE 0 END), 0)::bigint AS card_commission_total,
    COUNT(CASE WHEN t.payment_method != 'cash' THEN 1 END)::int AS card_trip_count,
    COALESCE(SUM(CASE WHEN t.payment_method = 'cash' THEN t.gross_fare_pence ELSE 0 END), 0)::bigint AS cash_gross_total,
    COALESCE(SUM(CASE WHEN t.payment_method = 'cash' THEN t.driver_net_pence ELSE 0 END), 0)::bigint AS cash_net_earnings,
    COALESCE(SUM(CASE WHEN t.payment_method = 'cash' THEN t.commission_pence ELSE 0 END), 0)::bigint AS cash_commission_debits,
    COUNT(CASE WHEN t.payment_method = 'cash' THEN 1 END)::int AS cash_trip_count,
    COALESCE(SUM(t.commission_pence), 0)::bigint AS company_commission_total,
    COALESCE(SUM(CASE WHEN t.completed_at::date = CURRENT_DATE THEN t.gross_fare_pence ELSE 0 END), 0)::bigint AS today_gross_earnings,
    COALESCE(SUM(CASE WHEN t.completed_at::date = CURRENT_DATE AND t.payment_method = 'cash' THEN t.gross_fare_pence ELSE 0 END), 0)::bigint AS today_cash_earnings,
    COALESCE(SUM(CASE WHEN t.completed_at::date = CURRENT_DATE AND t.payment_method != 'cash' THEN t.driver_net_pence ELSE 0 END), 0)::bigint AS today_card_earnings,
    COUNT(CASE WHEN t.completed_at::date = CURRENT_DATE THEN 1 END)::int AS today_trip_count
  FROM trips t
  WHERE t.status = 'completed'
    AND t.driver_id IS NOT NULL
  GROUP BY t.driver_id
),
ledger_totals AS (
  SELECT
    dl.driver_id,
    COALESCE(SUM(CASE WHEN dl.entry_type IN ('ADJUSTMENT', 'BONUS') THEN dl.amount_pence ELSE 0 END), 0)::bigint AS adjustments_total,
    COALESCE(SUM(CASE WHEN dl.entry_type IN ('PAYOUT', 'EARLY_CASHOUT', 'WEEKLY_PAYOUT', 'MANUAL_PAYOUT') THEN ABS(dl.amount_pence) ELSE 0 END), 0)::bigint AS total_payouts_sent,
    COALESCE(SUM(CASE WHEN dl.entry_type = 'CASHOUT_FEE' THEN ABS(dl.amount_pence) ELSE 0 END), 0)::bigint AS total_fees
  FROM driver_ledger dl
  GROUP BY dl.driver_id
),
payout_totals AS (
  SELECT
    pi.driver_id,
    COALESCE(SUM(CASE WHEN pi.status = 'completed' THEN pi.amount_pence ELSE 0 END), 0)::bigint AS payouts_completed
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
  COALESCE(tt.today_gross_earnings, 0) AS today_gross_earnings,
  COALESCE(tt.today_cash_earnings, 0) AS today_cash_earnings,
  COALESCE(tt.today_card_earnings, 0) AS today_card_earnings,
  COALESCE(tt.today_trip_count, 0) AS today_trip_count,
  COALESCE(lt.adjustments_total, 0) AS adjustments_total,
  GREATEST(COALESCE(lt.total_payouts_sent, 0), COALESCE(pt.payouts_completed, 0)) AS total_payouts_sent,
  COALESCE(lt.total_fees, 0) AS total_fees,
  (
    COALESCE(tt.card_net_credits, 0)
    - COALESCE(tt.cash_commission_debits, 0)
    - GREATEST(COALESCE(lt.total_payouts_sent, 0), COALESCE(pt.payouts_completed, 0))
    - COALESCE(lt.total_fees, 0)
    + COALESCE(lt.adjustments_total, 0)
  ) AS wallet_balance,
  GREATEST(
    COALESCE(tt.card_net_credits, 0)
    - COALESCE(tt.cash_commission_debits, 0)
    - GREATEST(COALESCE(lt.total_payouts_sent, 0), COALESCE(pt.payouts_completed, 0))
    - COALESCE(lt.total_fees, 0)
    + COALESCE(lt.adjustments_total, 0),
    0
  ) AS available_for_payout,
  GREATEST(
    -(
      COALESCE(tt.card_net_credits, 0)
      - COALESCE(tt.cash_commission_debits, 0)
      - GREATEST(COALESCE(lt.total_payouts_sent, 0), COALESCE(pt.payouts_completed, 0))
      - COALESCE(lt.total_fees, 0)
      + COALESCE(lt.adjustments_total, 0)
    ),
    0
  ) AS amount_owed_to_onecab
FROM drivers d
LEFT JOIN trip_totals tt ON tt.driver_id = d.id
LEFT JOIN ledger_totals lt ON lt.driver_id = d.id
LEFT JOIN payout_totals pt ON pt.driver_id = d.id;

GRANT SELECT ON public.driver_financial_summary TO authenticated;
GRANT SELECT ON public.driver_financial_summary TO anon;