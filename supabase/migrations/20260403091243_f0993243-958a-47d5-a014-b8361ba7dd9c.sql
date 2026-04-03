
-- =============================================================
-- Rebuild driver_financial_summary: 100% from driver_wallet_ledger
-- Removes ALL dependency on trip_finance table
-- =============================================================

CREATE OR REPLACE VIEW public.driver_financial_summary AS
WITH trip_flags AS (
  -- Per-trip aggregation: classify each trip as cash or card
  -- and extract gross, commission, net from ledger entries
  SELECT
    dwl.driver_id,
    dwl.related_trip_id,
    bool_or(dwl.type = 'CASH_TRIP_EARNING')  AS is_cash,
    bool_or(dwl.type = 'TRIP_EARNING_NET')    AS is_card,
    COALESCE(SUM(CASE WHEN dwl.type = 'CASH_TRIP_EARNING'    THEN dwl.amount_pence END), 0) AS cash_gross,
    COALESCE(SUM(CASE WHEN dwl.type = 'CASH_COMMISSION_DEBT' THEN ABS(dwl.amount_pence) END), 0) AS cash_comm,
    COALESCE(SUM(CASE WHEN dwl.type = 'TRIP_EARNING_NET'     THEN dwl.amount_pence END), 0) AS card_net,
    COALESCE(SUM(CASE WHEN dwl.type = 'PLATFORM_COMMISSION'  THEN dwl.amount_pence END), 0) AS plat_comm,
    COALESCE(SUM(CASE WHEN dwl.type = 'TIP_CREDIT'           THEN dwl.amount_pence END), 0) AS tip,
    MIN(dwl.created_at) AS trip_ts
  FROM driver_wallet_ledger dwl
  WHERE dwl.related_trip_id IS NOT NULL
  GROUP BY dwl.driver_id, dwl.related_trip_id
),
trip_totals AS (
  -- Driver-level aggregation of per-trip data
  SELECT
    driver_id,
    -- Gross = cash gross + card gross (card gross = card_net + card commission)
    SUM(cash_gross)::bigint
      + SUM(CASE WHEN is_card THEN card_net + plat_comm ELSE 0 END)::bigint
      AS gross_trip_total,
    -- Cash breakdown
    SUM(cash_gross)::bigint                                   AS cash_gross_total,
    SUM(cash_comm)::bigint                                    AS cash_commission_total,
    (SUM(cash_gross) - SUM(cash_comm))::bigint                AS cash_net_earnings,
    COUNT(*) FILTER (WHERE is_cash)                           AS cash_trip_count,
    -- Card breakdown
    (SUM(CASE WHEN is_card THEN card_net + plat_comm ELSE 0 END))::bigint AS card_gross_total,
    (SUM(CASE WHEN is_card THEN plat_comm ELSE 0 END))::bigint            AS card_commission_total,
    SUM(card_net)::bigint                                     AS card_net_credits,
    COUNT(*) FILTER (WHERE is_card)                           AS card_trip_count,
    -- Company commission = cash commission + card commission
    (SUM(cash_comm) + SUM(CASE WHEN is_card THEN plat_comm ELSE 0 END))::bigint AS company_commission_total,
    -- Trip counts
    COUNT(*)                                                  AS completed_trips,
    -- Today metrics
    (SUM(CASE WHEN trip_ts >= CURRENT_DATE THEN cash_gross ELSE 0 END)
      + SUM(CASE WHEN trip_ts >= CURRENT_DATE AND is_card THEN card_net + plat_comm ELSE 0 END))::bigint
      AS today_gross_earnings,
    SUM(CASE WHEN trip_ts >= CURRENT_DATE THEN cash_gross ELSE 0 END)::bigint
      AS today_cash_earnings,
    SUM(CASE WHEN trip_ts >= CURRENT_DATE AND is_card THEN card_net ELSE 0 END)::bigint
      AS today_card_earnings,
    COUNT(*) FILTER (WHERE trip_ts >= CURRENT_DATE)           AS today_trip_count
  FROM trip_flags
  GROUP BY driver_id
),
balance_totals AS (
  -- Wallet balance + non-trip financial items (payouts, adjustments, fees)
  SELECT
    driver_id,
    COALESCE(SUM(
      CASE WHEN type NOT IN ('PLATFORM_COMMISSION', 'CASH_TRIP_EARNING')
           THEN amount_pence ELSE 0 END
    ), 0)::bigint AS wallet_balance,
    COALESCE(SUM(
      CASE WHEN type IN ('ADJUSTMENT', 'BONUS')
           THEN amount_pence ELSE 0 END
    ), 0)::bigint AS adjustments_total,
    COALESCE(SUM(
      CASE WHEN type IN ('PAYOUT', 'EARLY_CASHOUT', 'WEEKLY_PAYOUT', 'MANUAL_PAYOUT')
           THEN ABS(amount_pence) ELSE 0 END
    ), 0)::bigint AS total_payouts_sent,
    COALESCE(SUM(
      CASE WHEN type = 'CASHOUT_FEE'
           THEN ABS(amount_pence) ELSE 0 END
    ), 0)::bigint AS total_fees
  FROM driver_wallet_ledger
  GROUP BY driver_id
)
SELECT
  d.id                                                       AS driver_id,
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
  COALESCE(sa.currency_code, r.currency_code, 'GBP'::text)  AS currency_code,
  d.region_id,
  -- Trip totals (100% from driver_wallet_ledger)
  COALESCE(tt.gross_trip_total, 0::bigint)                   AS gross_trip_total,
  COALESCE(tt.completed_trips, 0)::integer                   AS completed_trips,
  COALESCE(tt.card_net_credits, 0::bigint)                   AS card_net_credits,
  COALESCE(tt.card_gross_total, 0::bigint)                   AS card_gross_total,
  COALESCE(tt.card_commission_total, 0::bigint)              AS card_commission_total,
  COALESCE(tt.card_trip_count, 0)::integer                   AS card_trip_count,
  COALESCE(tt.cash_gross_total, 0::bigint)                   AS cash_gross_total,
  COALESCE(tt.cash_net_earnings, 0::bigint)                  AS cash_net_earnings,
  COALESCE(tt.cash_commission_total, 0::bigint)              AS cash_commission_debits,
  COALESCE(tt.cash_trip_count, 0)::integer                   AS cash_trip_count,
  COALESCE(tt.company_commission_total, 0::bigint)           AS company_commission_total,
  COALESCE(tt.today_gross_earnings, 0::bigint)               AS today_gross_earnings,
  COALESCE(tt.today_cash_earnings, 0::bigint)                AS today_cash_earnings,
  COALESCE(tt.today_card_earnings, 0::bigint)                AS today_card_earnings,
  COALESCE(tt.today_trip_count, 0)::integer                  AS today_trip_count,
  -- Balance items (from driver_wallet_ledger)
  COALESCE(bt.adjustments_total, 0::bigint)                  AS adjustments_total,
  COALESCE(bt.total_payouts_sent, 0::bigint)                 AS total_payouts_sent,
  COALESCE(bt.total_fees, 0::bigint)                         AS total_fees,
  COALESCE(bt.wallet_balance, 0::bigint)                     AS wallet_balance,
  GREATEST(COALESCE(bt.wallet_balance, 0::bigint), 0::bigint) AS available_for_payout,
  GREATEST(-COALESCE(bt.wallet_balance, 0::bigint), 0::bigint) AS amount_owed_to_onecab
FROM drivers d
  LEFT JOIN service_areas sa ON sa.id = d.service_area_id
  LEFT JOIN regions r ON r.id = d.region_id
  LEFT JOIN trip_totals tt ON tt.driver_id = d.id
  LEFT JOIN balance_totals bt ON bt.driver_id = d.id;
