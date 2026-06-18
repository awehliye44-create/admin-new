-- P0 finance SSOT: ledger reversals, commission recovered, payout lifecycle, phantom credit backfill.

-- 1) Expand ledger types
ALTER TABLE public.driver_wallet_ledger DROP CONSTRAINT IF EXISTS driver_wallet_ledger_type_check;
ALTER TABLE public.driver_wallet_ledger ADD CONSTRAINT driver_wallet_ledger_type_check
  CHECK (type = ANY (ARRAY[
    'TRIP_EARNING_NET', 'CASH_TRIP_EARNING', 'CASH_COMMISSION_DEBT',
    'DRIVER_TIP_CREDIT', 'TIP_CREDIT', 'PLATFORM_COMMISSION', 'COMPANY_COMMISSION',
    'WEEKLY_PAYOUT', 'EARLY_CASHOUT', 'CASHOUT_FEE',
    'ADJUSTMENT', 'REFUND_DEBIT', 'PAYOUT', 'MANUAL_PAYOUT', 'PAYOUT_CREATED',
    'BONUS', 'DEBT_RECOVERY', 'PAYOUT_FAILED_RETURN', 'LEDGER_REVERSAL', 'COMMISSION_RECOVERED'
  ]));

-- 2) Payout batch diagnostics for silent failures
ALTER TABLE public.payout_batches
  ADD COLUMN IF NOT EXISTS failure_code TEXT,
  ADD COLUMN IF NOT EXISTS failure_reason TEXT,
  ADD COLUMN IF NOT EXISTS provider_response JSONB,
  ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ;

ALTER TABLE public.payout_batches DROP CONSTRAINT IF EXISTS payout_batches_status_check;
ALTER TABLE public.payout_batches ADD CONSTRAINT payout_batches_status_check
  CHECK (status = ANY (ARRAY[
    'pending', 'processing', 'completed', 'failed', 'partial', 'PARTIAL_SETTLEMENT',
    'INVALID_ORPHANED', 'CREATED', 'READY', 'BLOCKED', 'SENT', 'PAID', 'RETURNED'
  ]));

ALTER TABLE public.payout_items
  ADD COLUMN IF NOT EXISTS failure_code TEXT,
  ADD COLUMN IF NOT EXISTS provider_response JSONB;

ALTER TABLE public.payout_items DROP CONSTRAINT IF EXISTS payout_items_status_check;
ALTER TABLE public.payout_items ADD CONSTRAINT payout_items_status_check
  CHECK (status = ANY (ARRAY[
    'pending', 'processing', 'completed', 'failed', 'ledger_sync_failed',
    'CREATED', 'READY', 'BLOCKED', 'SENT', 'PAID', 'FAILED', 'RETURNED', 'INVALID_ORPHANED'
  ]));

ALTER TABLE public.payout_items DROP CONSTRAINT IF EXISTS payout_items_settlement_status_check;
ALTER TABLE public.payout_items ADD CONSTRAINT payout_items_settlement_status_check
  CHECK (
    settlement_status IS NULL
    OR settlement_status = ANY (ARRAY[
      'PENDING', 'PROCESSING', 'COMPLETE', 'FAILED', 'PARTIAL_SETTLEMENT',
      'CREATED', 'READY', 'BLOCKED', 'SENT', 'PAID', 'RETURNED', 'INVALID_ORPHANED'
    ])
  );

-- 3) Mark existing orphaned batches (amount > 0, zero payout_items)
UPDATE public.payout_batches pb
SET
  status = 'INVALID_ORPHANED',
  failure_code = 'ORPHANED_NO_ITEMS',
  failure_reason = 'Batch has amount but no payout items',
  failed_at = COALESCE(pb.failed_at, pb.completed_at, pb.updated_at, NOW()),
  notes = COALESCE(pb.notes, 'INVALID_ORPHANED: Batch has amount but no payout items')
WHERE pb.total_amount_pence > 0
  AND NOT EXISTS (SELECT 1 FROM public.payout_items pi WHERE pi.batch_id = pb.id);

-- 4) Backfill LEDGER_REVERSAL for capture_failed card trips with phantom credits
-- One LEDGER_REVERSAL per trip (unique_trip_ledger_entry on related_trip_id + type).
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT
      l.driver_id,
      l.related_trip_id AS trip_id,
      SUM(l.amount_pence)::bigint AS total_phantom_pence,
      string_agg(l.id::text || ':' || l.type, ', ' ORDER BY l.id) AS reversed_refs
    FROM driver_wallet_ledger l
    INNER JOIN trips t ON t.id = l.related_trip_id
    LEFT JOIN payments p ON p.trip_id = t.id
    WHERE l.type IN ('TRIP_EARNING_NET', 'DRIVER_TIP_CREDIT')
      AND l.amount_pence > 0
      AND UPPER(COALESCE(t.payment_method, '')) <> 'CASH'
      AND (
        t.payment_status = 'capture_failed'
        OR p.status = 'capture_failed'
      )
      AND NOT EXISTS (
        SELECT 1 FROM driver_wallet_ledger rev
        WHERE rev.related_trip_id = l.related_trip_id
          AND rev.type = 'LEDGER_REVERSAL'
      )
    GROUP BY l.driver_id, l.related_trip_id
  LOOP
    INSERT INTO driver_wallet_ledger (
      driver_id, related_trip_id, type, amount_pence, description
    ) VALUES (
      r.driver_id,
      r.trip_id,
      'LEDGER_REVERSAL',
      -r.total_phantom_pence,
      'Card capture failed — reversing phantom driver credit (reverses ' || r.reversed_refs || ')'
    );

    UPDATE trip_finance
    SET financial_status = 'PAYMENT_NOT_CAPTURED',
        updated_at = NOW()
    WHERE trip_id = r.trip_id;
  END LOOP;
END $$;

-- 5) driver_financial_summary — owed from ledger, not wallet sign
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
    COALESCE(SUM(
      CASE WHEN type NOT IN ('PLATFORM_COMMISSION', 'CASH_TRIP_EARNING', 'COMMISSION_RECOVERED')
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
