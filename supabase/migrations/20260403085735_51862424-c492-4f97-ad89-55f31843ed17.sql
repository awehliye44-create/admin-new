
-- Fix driver_financial_summary to use driver_wallet_ledger for wallet balance
-- matching the Driver App's recalculate_driver_wallet formula exactly:
-- wallet_balance = SUM(amount_pence) WHERE type NOT IN ('PLATFORM_COMMISSION', 'CASH_TRIP_EARNING')

CREATE OR REPLACE VIEW public.driver_financial_summary
WITH (security_barrier = true, security_invoker = on) AS
WITH wallet_ledger_totals AS (
    -- Source of truth for wallet balance: driver_wallet_ledger
    -- Matches Driver App's recalculate_driver_wallet() exactly
    SELECT dwl.driver_id,
        COALESCE(SUM(
            CASE WHEN dwl.type NOT IN ('PLATFORM_COMMISSION', 'CASH_TRIP_EARNING') THEN dwl.amount_pence ELSE 0 END
        ), 0) AS wallet_balance,
        COALESCE(SUM(
            CASE WHEN dwl.type = 'CASH_COMMISSION_DEBT' THEN ABS(dwl.amount_pence) ELSE 0 END
        ), 0) AS cash_commission_debits,
        COALESCE(SUM(
            CASE WHEN dwl.type = 'PLATFORM_COMMISSION' THEN dwl.amount_pence ELSE 0 END
        ), 0) AS company_commission_total,
        COALESCE(SUM(
            CASE WHEN dwl.type = 'TRIP_EARNING_NET' THEN dwl.amount_pence ELSE 0 END
        ), 0) AS card_net_credits,
        COALESCE(SUM(
            CASE WHEN dwl.type IN ('ADJUSTMENT', 'BONUS') THEN dwl.amount_pence ELSE 0 END
        ), 0) AS adjustments_total,
        COALESCE(SUM(
            CASE WHEN dwl.type IN ('PAYOUT', 'EARLY_CASHOUT', 'WEEKLY_PAYOUT', 'MANUAL_PAYOUT') THEN ABS(dwl.amount_pence) ELSE 0 END
        ), 0) AS total_payouts_sent,
        COALESCE(SUM(
            CASE WHEN dwl.type = 'CASHOUT_FEE' THEN ABS(dwl.amount_pence) ELSE 0 END
        ), 0) AS total_fees,
        COALESCE(SUM(
            CASE WHEN dwl.type = 'TRIP_EARNING_NET' AND dwl.created_at >= CURRENT_DATE THEN dwl.amount_pence ELSE 0 END
        ), 0) AS today_card_earnings,
        COALESCE(SUM(
            CASE WHEN dwl.type = 'CASH_COMMISSION_DEBT' AND dwl.created_at >= CURRENT_DATE THEN ABS(dwl.amount_pence) ELSE 0 END
        ), 0) AS today_cash_commission,
        COUNT(DISTINCT CASE WHEN dwl.type IN ('TRIP_EARNING_NET', 'CASH_COMMISSION_DEBT') THEN dwl.related_trip_id END)::integer AS completed_trips,
        COUNT(DISTINCT CASE WHEN dwl.type = 'TRIP_EARNING_NET' THEN dwl.related_trip_id END)::integer AS card_trip_count,
        COUNT(DISTINCT CASE WHEN dwl.type = 'CASH_COMMISSION_DEBT' THEN dwl.related_trip_id END)::integer AS cash_trip_count,
        COUNT(DISTINCT CASE WHEN dwl.type IN ('TRIP_EARNING_NET', 'CASH_COMMISSION_DEBT') AND dwl.created_at >= CURRENT_DATE THEN dwl.related_trip_id END)::integer AS today_trip_count
    FROM driver_wallet_ledger dwl
    GROUP BY dwl.driver_id
), trip_finance_totals AS (
    SELECT tf.driver_id,
        COALESCE(SUM(tf.commissionable_subtotal_pence), 0) AS gross_trip_total,
        COALESCE(SUM(CASE WHEN UPPER(tf.payment_method) <> 'CASH' THEN tf.commissionable_subtotal_pence ELSE 0 END), 0) AS card_gross_total,
        COALESCE(SUM(CASE WHEN UPPER(tf.payment_method) <> 'CASH' THEN tf.platform_commission_pence ELSE 0 END), 0) AS card_commission_total,
        COALESCE(SUM(CASE WHEN UPPER(tf.payment_method) = 'CASH' THEN tf.commissionable_subtotal_pence ELSE 0 END), 0) AS cash_gross_total,
        COALESCE(SUM(CASE WHEN UPPER(tf.payment_method) = 'CASH' THEN tf.driver_net_before_tip_pence ELSE 0 END), 0) AS cash_net_earnings,
        COALESCE(SUM(CASE WHEN tf.created_at >= CURRENT_DATE THEN tf.commissionable_subtotal_pence ELSE 0 END), 0) AS today_gross_earnings,
        COALESCE(SUM(CASE WHEN UPPER(tf.payment_method) = 'CASH' AND tf.created_at >= CURRENT_DATE THEN tf.commissionable_subtotal_pence ELSE 0 END), 0) AS today_cash_earnings
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
    COALESCE(wlt.completed_trips, 0) AS completed_trips,
    COALESCE(wlt.card_net_credits, 0) AS card_net_credits,
    COALESCE(tft.card_gross_total, 0) AS card_gross_total,
    COALESCE(tft.card_commission_total, 0) AS card_commission_total,
    COALESCE(wlt.card_trip_count, 0) AS card_trip_count,
    COALESCE(tft.cash_gross_total, 0) AS cash_gross_total,
    COALESCE(tft.cash_net_earnings, 0) AS cash_net_earnings,
    COALESCE(wlt.cash_commission_debits, 0) AS cash_commission_debits,
    COALESCE(wlt.cash_trip_count, 0) AS cash_trip_count,
    COALESCE(wlt.company_commission_total, 0) AS company_commission_total,
    COALESCE(tft.today_gross_earnings, 0) AS today_gross_earnings,
    COALESCE(tft.today_cash_earnings, 0) AS today_cash_earnings,
    COALESCE(wlt.today_card_earnings, 0) AS today_card_earnings,
    COALESCE(wlt.today_trip_count, 0) AS today_trip_count,
    COALESCE(wlt.adjustments_total, 0) AS adjustments_total,
    COALESCE(wlt.total_payouts_sent, 0) AS total_payouts_sent,
    COALESCE(wlt.total_fees, 0) AS total_fees,
    COALESCE(wlt.wallet_balance, 0) AS wallet_balance,
    GREATEST(COALESCE(wlt.wallet_balance, 0), 0) AS available_for_payout,
    GREATEST(-COALESCE(wlt.wallet_balance, 0), 0) AS amount_owed_to_onecab
FROM drivers d
LEFT JOIN service_areas sa ON sa.id = d.service_area_id
LEFT JOIN regions r ON r.id = d.region_id
LEFT JOIN wallet_ledger_totals wlt ON wlt.driver_id = d.id
LEFT JOIN trip_finance_totals tft ON tft.driver_id = d.id;
