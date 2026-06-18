-- Phase 3C.4 — Admin wallet SSOT alignment (Phase 3A.4 ledger liability).
-- COMMISSION_RECOVERED offsets DEBT_RECOVERY in wallet balance; must NOT be excluded.

-- 1) driver_financial_summary — wallet_balance = ledger liability SSOT
DROP VIEW IF EXISTS public.driver_financial_summary;

CREATE VIEW public.driver_financial_summary AS
WITH trip_flags AS (
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
    AND dwl.type NOT IN ('LEDGER_REVERSAL', 'COMMISSION_RECOVERED')
  GROUP BY dwl.driver_id, dwl.related_trip_id
),
trip_totals AS (
  SELECT
    driver_id,
    SUM(cash_gross)::bigint
      + SUM(CASE WHEN is_card THEN card_net + plat_comm ELSE 0 END)::bigint
      AS gross_trip_total,
    SUM(cash_gross)::bigint                                   AS cash_gross_total,
    SUM(cash_comm)::bigint                                    AS cash_commission_total,
    (SUM(cash_gross) - SUM(cash_comm))::bigint                AS cash_net_earnings,
    COUNT(*) FILTER (WHERE is_cash)                           AS cash_trip_count,
    (SUM(CASE WHEN is_card THEN card_net + plat_comm ELSE 0 END))::bigint AS card_gross_total,
    (SUM(CASE WHEN is_card THEN plat_comm ELSE 0 END))::bigint            AS card_commission_total,
    SUM(card_net)::bigint                                     AS card_net_credits,
    COUNT(*) FILTER (WHERE is_card)                           AS card_trip_count,
    (SUM(cash_comm) + SUM(CASE WHEN is_card THEN plat_comm ELSE 0 END))::bigint AS company_commission_total,
    COUNT(*)                                                  AS completed_trips,
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
  SELECT
    driver_id,
  -- Phase 3A.4: exclude reporting-only PLATFORM_COMMISSION + CASH_TRIP_EARNING only
    COALESCE(SUM(
      CASE WHEN type NOT IN ('PLATFORM_COMMISSION', 'CASH_TRIP_EARNING')
           THEN amount_pence ELSE 0 END
    ), 0)::bigint AS wallet_balance,
    COALESCE(SUM(CASE WHEN type = 'CASH_COMMISSION_DEBT' THEN ABS(amount_pence) ELSE 0 END), 0)::bigint AS cash_debt_created,
    COALESCE(SUM(CASE WHEN type = 'DEBT_RECOVERY' THEN ABS(amount_pence) ELSE 0 END), 0)::bigint AS debt_recovery_total,
    COALESCE(SUM(CASE WHEN type = 'COMMISSION_RECOVERED' THEN amount_pence ELSE 0 END), 0)::bigint AS commission_recovered_total,
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
),
reserved_cashout_totals AS (
  SELECT
    driver_id,
    COALESCE(SUM(requested_cashout_pence), 0)::bigint AS reserved_cashout_pence
  FROM driver_early_cashouts
  WHERE status IN ('pending', 'processing')
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
  COALESCE(bt.adjustments_total, 0::bigint)                  AS adjustments_total,
  COALESCE(bt.total_payouts_sent, 0::bigint)                 AS total_payouts_sent,
  COALESCE(bt.total_fees, 0::bigint)                         AS total_fees,
  COALESCE(bt.wallet_balance, 0::bigint)                     AS wallet_balance,
  GREATEST(COALESCE(bt.wallet_balance, 0::bigint), 0::bigint) AS available_for_payout,
  COALESCE(rc.reserved_cashout_pence, 0::bigint)             AS reserved_cashout_pence,
  GREATEST(
    COALESCE(bt.wallet_balance, 0::bigint) - COALESCE(rc.reserved_cashout_pence, 0::bigint),
    0::bigint
  )                                                          AS net_available_for_payout,
  GREATEST(
    COALESCE(bt.cash_debt_created, 0::bigint)
      - COALESCE(bt.debt_recovery_total, 0::bigint),
    0::bigint
  )                                                          AS amount_owed_to_onecab
FROM drivers d
  LEFT JOIN service_areas sa ON sa.id = d.service_area_id
  LEFT JOIN regions r ON r.id = d.region_id
  LEFT JOIN trip_totals tt ON tt.driver_id = d.id
  LEFT JOIN balance_totals bt ON bt.driver_id = d.id
  LEFT JOIN reserved_cashout_totals rc ON rc.driver_id = d.id;

ALTER VIEW public.driver_financial_summary SET (security_invoker = on);
GRANT SELECT ON public.driver_financial_summary TO authenticated;
GRANT SELECT ON public.driver_financial_summary TO anon;

COMMENT ON VIEW public.driver_financial_summary IS
  'Phase 3A.4 wallet_balance = ledger liability SSOT (includes COMMISSION_RECOVERED; excludes PLATFORM_COMMISSION, CASH_TRIP_EARNING only).';

-- 2) driver_wallets cache — same exclusion set as computeLedgerWalletBalancePence
CREATE OR REPLACE FUNCTION public.recalculate_driver_wallet(p_driver_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_available integer;
  v_lifetime integer;
BEGIN
  SELECT COALESCE(SUM(amount_pence), 0)
  INTO v_available
  FROM driver_wallet_ledger
  WHERE driver_id = p_driver_id
    AND type NOT IN ('PLATFORM_COMMISSION', 'CASH_TRIP_EARNING');

  SELECT COALESCE(SUM(amount_pence), 0)
  INTO v_lifetime
  FROM driver_wallet_ledger
  WHERE driver_id = p_driver_id
    AND amount_pence > 0
    AND type NOT IN ('PLATFORM_COMMISSION', 'CASH_TRIP_EARNING');

  INSERT INTO driver_wallets (driver_id, available_pence, pending_pence, lifetime_earned_pence, updated_at)
  VALUES (p_driver_id, v_available, 0, v_lifetime, now())
  ON CONFLICT (driver_id)
  DO UPDATE SET
    available_pence = v_available,
    lifetime_earned_pence = v_lifetime,
    updated_at = now();
END;
$function$;

CREATE OR REPLACE FUNCTION public.trigger_recalculate_wallet()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_driver_id uuid;
  v_available bigint;
  v_lifetime bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_driver_id := OLD.driver_id;
  ELSE
    v_driver_id := NEW.driver_id;
  END IF;

  SELECT COALESCE(SUM(amount_pence), 0)
  INTO v_available
  FROM driver_wallet_ledger
  WHERE driver_id = v_driver_id
    AND type NOT IN ('PLATFORM_COMMISSION', 'CASH_TRIP_EARNING');

  SELECT COALESCE(SUM(amount_pence), 0)
  INTO v_lifetime
  FROM driver_wallet_ledger
  WHERE driver_id = v_driver_id
    AND amount_pence > 0
    AND type NOT IN ('PLATFORM_COMMISSION', 'CASH_TRIP_EARNING');

  INSERT INTO driver_wallets (driver_id, available_pence, pending_pence, lifetime_earned_pence, updated_at)
  VALUES (v_driver_id, v_available, 0, v_lifetime, now())
  ON CONFLICT (driver_id)
  DO UPDATE SET
    available_pence = v_available,
    lifetime_earned_pence = v_lifetime,
    updated_at = now();

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$function$;

COMMENT ON FUNCTION public.recalculate_driver_wallet(uuid) IS
  'Rebuild driver_wallets from Phase 3A.4 ledger wallet SSOT — excludes PLATFORM_COMMISSION and CASH_TRIP_EARNING only.';

-- 3) Rebuild cache for all drivers with ledger activity
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT DISTINCT driver_id FROM driver_wallet_ledger
  LOOP
    PERFORM recalculate_driver_wallet(r.driver_id);
  END LOOP;
END $$;
