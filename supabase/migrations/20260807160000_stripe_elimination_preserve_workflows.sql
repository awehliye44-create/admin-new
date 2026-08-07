-- =============================================================================
-- Stripe elimination (forward cleanup) — PRESERVE workflows / Edge Functions
-- =============================================================================
-- Adds provider_* columns, backfills, repairs readers, drops Stripe-only schema.
-- =============================================================================

BEGIN;

-- 1) Provider columns
ALTER TABLE public.driver_wallet_ledger
  ADD COLUMN IF NOT EXISTS provider_transfer_id text;

ALTER TABLE public.driver_earning_settlement
  ADD COLUMN IF NOT EXISTS provider_transfer_id text,
  ADD COLUMN IF NOT EXISTS provider_payout_id text,
  ADD COLUMN IF NOT EXISTS provider_charge_id text,
  ADD COLUMN IF NOT EXISTS provider_available_on timestamptz,
  ADD COLUMN IF NOT EXISTS provider_balance_tx_id text;

ALTER TABLE public.payout_items
  ADD COLUMN IF NOT EXISTS provider_transfer_id text,
  ADD COLUMN IF NOT EXISTS provider_payout_id text,
  ADD COLUMN IF NOT EXISTS provider_fee_pence integer;

ALTER TABLE public.driver_early_cashouts
  ADD COLUMN IF NOT EXISTS provider_transfer_id text,
  ADD COLUMN IF NOT EXISTS provider_payout_id text;

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS provider_order_id text;

ALTER TABLE public.trip_finance
  ADD COLUMN IF NOT EXISTS provider_order_id text,
  ADD COLUMN IF NOT EXISTS provider_processing_fee_pence integer;

-- orphan_payments unique provider_order_id
UPDATE public.orphan_payments
SET provider_order_id = COALESCE(NULLIF(btrim(provider_order_id), ''), NULLIF(btrim(stripe_payment_intent_id), ''))
WHERE provider_order_id IS NULL OR btrim(provider_order_id) = '';

DELETE FROM public.orphan_payments
WHERE provider_order_id IS NULL OR btrim(provider_order_id) = '';

CREATE UNIQUE INDEX IF NOT EXISTS orphan_payments_provider_order_id_uidx
  ON public.orphan_payments (provider_order_id);

ALTER TABLE public.orphan_payments
  ALTER COLUMN provider_order_id SET NOT NULL;

ALTER TABLE public.orphan_payments
  ALTER COLUMN stripe_payment_intent_id DROP NOT NULL;

-- 2) Backfill
UPDATE public.trips SET
  provider_order_id = COALESCE(provider_order_id, NULLIF(stripe_payment_intent_id, '')),
  provider_fee_pence = COALESCE(provider_fee_pence, stripe_processing_fee_pence, stripe_fee_amount),
  provider_transfer_id = COALESCE(provider_transfer_id, NULLIF(stripe_transfer_id, '')),
  provider_charge_id = COALESCE(provider_charge_id, NULLIF(stripe_charge_id, ''))
WHERE stripe_payment_intent_id IS NOT NULL
   OR stripe_processing_fee_pence IS NOT NULL
   OR stripe_fee_amount IS NOT NULL
   OR stripe_transfer_id IS NOT NULL
   OR stripe_charge_id IS NOT NULL;

UPDATE public.payments SET
  provider_payment_id = COALESCE(provider_payment_id, NULLIF(stripe_payment_intent_id, '')),
  provider_order_id = COALESCE(provider_order_id, NULLIF(stripe_payment_intent_id, '')),
  provider_fee_pence = COALESCE(provider_fee_pence, stripe_fee_pence)
WHERE stripe_payment_intent_id IS NOT NULL
   OR stripe_fee_pence IS NOT NULL;

UPDATE public.driver_wallet_ledger SET
  provider_transfer_id = COALESCE(provider_transfer_id, NULLIF(stripe_transfer_id, '')),
  provider_payout_id = COALESCE(provider_payout_id, NULLIF(stripe_payout_id, ''))
WHERE stripe_transfer_id IS NOT NULL OR stripe_payout_id IS NOT NULL;

UPDATE public.driver_earning_settlement SET
  provider_transfer_id = COALESCE(provider_transfer_id, NULLIF(stripe_transfer_id, '')),
  provider_charge_id = COALESCE(provider_charge_id, NULLIF(stripe_charge_id, '')),
  provider_available_on = COALESCE(provider_available_on, stripe_available_on),
  provider_balance_tx_id = COALESCE(provider_balance_tx_id, NULLIF(stripe_balance_tx_id, ''))
WHERE stripe_transfer_id IS NOT NULL
   OR stripe_charge_id IS NOT NULL
   OR stripe_available_on IS NOT NULL
   OR stripe_balance_tx_id IS NOT NULL;

UPDATE public.payout_items SET
  provider_transfer_id = COALESCE(provider_transfer_id, NULLIF(stripe_transfer_id, '')),
  provider_payout_id = COALESCE(provider_payout_id, NULLIF(stripe_payout_id, '')),
  provider_fee_pence = COALESCE(provider_fee_pence, stripe_fee_pence)
WHERE stripe_transfer_id IS NOT NULL OR stripe_payout_id IS NOT NULL OR stripe_fee_pence IS NOT NULL;

UPDATE public.driver_early_cashouts SET
  provider_transfer_id = COALESCE(provider_transfer_id, NULLIF(stripe_transfer_id, '')),
  provider_payout_id = COALESCE(provider_payout_id, NULLIF(stripe_payout_id, ''))
WHERE stripe_transfer_id IS NOT NULL OR stripe_payout_id IS NOT NULL;

UPDATE public.admin_payment_audit SET
  provider_payment_id = COALESCE(provider_payment_id, NULLIF(stripe_payment_intent_id, ''))
WHERE stripe_payment_intent_id IS NOT NULL
  AND (provider_payment_id IS NULL OR btrim(provider_payment_id) = '');

UPDATE public.trip_finance SET
  provider_order_id = COALESCE(provider_order_id, NULLIF(stripe_payment_intent_id, '')),
  provider_processing_fee_pence = COALESCE(provider_processing_fee_pence, stripe_processing_fee_pence)
WHERE stripe_payment_intent_id IS NOT NULL OR stripe_processing_fee_pence IS NOT NULL;

-- 3) Repair list_driver_own_trip_history (exact prior body; stripe refs removed)
-- My Trips Cancelled tab: include missed / lost ride offers for the authenticated driver.
-- Root cause: list_driver_own_trip_history only returned trips.driver_id / confirmed /
-- previous / cancelled_driver_ids. Offers revoked because another driver accepted never
-- attach the losing driver to trips, so "Accepted by another driver" was invisible.
-- Source of truth for those outcomes: public.ride_offers (status + revoked_reason).

CREATE OR REPLACE FUNCTION public.list_driver_own_trip_history(
  p_limit integer DEFAULT 50,
  p_before timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_tab text DEFAULT NULL::text,
  p_trip_id uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_driver_id uuid := public.current_driver_id();
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
  v_tab text := lower(nullif(trim(COALESCE(p_tab, '')), ''));
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;

  IF v_driver_id IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;

  IF v_tab IS NOT NULL AND v_tab NOT IN ('completed', 'cancelled') THEN
    RAISE EXCEPTION 'invalid_tab' USING ERRCODE = '22023';
  END IF;

  RETURN COALESCE(
    (
      SELECT jsonb_agg(to_jsonb(row) ORDER BY row.sort_at DESC)
      FROM (
        SELECT
          deduped.id,
          deduped.public_trip_ref,
          deduped.backend_status,
          deduped.cancellation_reason_code,
          deduped.cancelled_by,
          deduped.cancelled_by_role,
          deduped.financial_outcome,
          deduped.service_area_label,
          deduped.pickup_area_label,
          deduped.dropoff_area_label,
          deduped.total_stops,
          deduped.requested_at,
          deduped.pickup_at,
          deduped.dropoff_at,
          deduped.cancelled_at,
          deduped.closed_at,
          deduped.payable_amount_pence,
          deduped.has_card_payment_record,
          deduped.payment_method,
          deduped.booking_type,
          deduped.vehicle_type,
          deduped.sort_at,
          deduped.is_active
        FROM (
          SELECT DISTINCT ON (combined.id)
            combined.id,
            combined.public_trip_ref,
            combined.backend_status,
            combined.cancellation_reason_code,
            combined.cancelled_by,
            combined.cancelled_by_role,
            combined.financial_outcome,
            combined.service_area_label,
            combined.pickup_area_label,
            combined.dropoff_area_label,
            combined.total_stops,
            combined.requested_at,
            combined.pickup_at,
            combined.dropoff_at,
            combined.cancelled_at,
            combined.closed_at,
            combined.payable_amount_pence,
            combined.has_card_payment_record,
            combined.payment_method,
            combined.booking_type,
            combined.vehicle_type,
            combined.sort_at,
            combined.is_active
          FROM (
            -- A) Terminal trips this driver owned / was cancelled from
            SELECT
              t.id,
              COALESCE(t.trip_number, t.trip_code, left(t.id::text, 8)) AS public_trip_ref,
              t.status AS backend_status,
              COALESCE(t.cancellation_reason, t.cancel_reason, t.cancelled_by_role) AS cancellation_reason_code,
              t.cancelled_by,
              t.cancelled_by_role,
              t.financial_outcome,
              sa.name AS service_area_label,
              sa.name AS pickup_area_label,
              sa.name AS dropoff_area_label,
              COALESCE(t.total_stops, 1) AS total_stops,
              t.created_at AS requested_at,
              t.started_at AS pickup_at,
              t.completed_at AS dropoff_at,
              t.cancelled_at,
              CASE
                WHEN lower(COALESCE(t.status, '')) = 'no_show'
                  THEN COALESCE(t.completed_at, t.cancelled_at, t.updated_at)
                ELSE t.completed_at
              END AS closed_at,
              COALESCE(
                t.driver_total_earnings_pence,
                t.driver_net_pence,
                t.no_show_charge_pence,
                t.cancellation_fee_pence,
                t.late_cancel_fee_pence
              ) AS payable_amount_pence,
              (t.payment_method IS NOT NULL AND lower(t.payment_method) IN ('card', 'apple_pay', 'google_pay', 'saved_card', 'revolut'))
                OR (t.provider_order_id IS NOT NULL)
                OR (t.payment_session_id IS NOT NULL) AS has_card_payment_record,
              t.payment_method,
              t.booking_type,
              t.vehicle_type,
              COALESCE(
                CASE
                  WHEN lower(COALESCE(t.status, '')) IN ('completed', 'no_show')
                    THEN COALESCE(t.completed_at, t.cancelled_at, t.updated_at, t.created_at)
                  ELSE COALESCE(t.cancelled_at, t.updated_at, t.created_at)
                END,
                t.created_at
              ) AS sort_at,
              false AS is_active,
              1 AS source_pri
            FROM public.trips t
            LEFT JOIN public.service_areas sa ON sa.id = t.service_area_id
            WHERE (
                t.driver_id = v_driver_id
                OR t.confirmed_driver_id = v_driver_id
                OR t.previous_driver_id = v_driver_id
                OR (t.cancelled_driver_ids IS NOT NULL AND t.cancelled_driver_ids @> ARRAY[v_driver_id])
              )
              AND (
                p_trip_id IS NULL
                OR t.id = p_trip_id
              )
              AND lower(COALESCE(t.status, '')) IN (
                'completed',
                'no_show',
                'cancelled',
                'customer_cancelled',
                'driver_cancelled',
                'expired',
                'expired_no_driver',
                'missed'
              )
              AND (
                v_tab IS NULL
                OR (
                  v_tab = 'completed'
                  AND lower(COALESCE(t.status, '')) IN ('completed', 'no_show')
                )
                OR (
                  v_tab = 'cancelled'
                  AND lower(COALESCE(t.status, '')) IN (
                    'cancelled',
                    'customer_cancelled',
                    'driver_cancelled',
                    'expired',
                    'expired_no_driver',
                    'missed'
                  )
                )
              )
              AND (p_before IS NULL OR COALESCE(
                CASE
                  WHEN lower(COALESCE(t.status, '')) IN ('completed', 'no_show')
                    THEN COALESCE(t.completed_at, t.cancelled_at, t.updated_at, t.created_at)
                  ELSE COALESCE(t.cancelled_at, t.updated_at, t.created_at)
                END,
                t.created_at
              ) < p_before)

            UNION ALL

            -- B) Missed / lost offers (never assigned to this driver on trips)
            SELECT
              ro.trip_id AS id,
              COALESCE(t.trip_number, t.trip_code, left(ro.trip_id::text, 8)) AS public_trip_ref,
              CASE
                WHEN lower(ro.status) = 'declined' THEN 'driver_declined'
                WHEN lower(ro.status) = 'expired' THEN 'offer_expired'
                WHEN lower(COALESCE(ro.revoked_reason, '')) = 'another_offer_accepted'
                  THEN 'cancelled'
                WHEN lower(COALESCE(ro.revoked_reason, '')) IN (
                  'passenger_cancelled', 'trip_cancelled', 'trip_terminal_cancel'
                ) THEN 'cancelled'
                WHEN lower(COALESCE(ro.revoked_reason, '')) IN (
                  'cancelled_by_admin', 'admin_cancelled'
                ) THEN 'cancelled'
                WHEN lower(COALESCE(ro.revoked_reason, '')) = 'trip_expired_no_driver'
                  THEN 'offer_expired'
                ELSE 'cancelled'
              END AS backend_status,
              CASE
                WHEN lower(ro.status) = 'declined' THEN 'driver_declined'
                WHEN lower(ro.status) = 'expired' THEN 'offer_expired'
                WHEN lower(COALESCE(ro.revoked_reason, '')) = 'another_offer_accepted'
                  THEN 'accepted_by_another_driver'
                WHEN lower(COALESCE(ro.revoked_reason, '')) = 'passenger_cancelled'
                  THEN 'passenger_cancelled'
                WHEN lower(COALESCE(ro.revoked_reason, '')) IN (
                  'trip_cancelled', 'trip_terminal_cancel'
                ) THEN 'passenger_cancelled'
                WHEN lower(COALESCE(ro.revoked_reason, '')) IN (
                  'cancelled_by_admin', 'admin_cancelled'
                ) THEN 'admin_cancelled'
                WHEN lower(COALESCE(ro.revoked_reason, '')) = 'trip_expired_no_driver'
                  THEN 'offer_expired'
                ELSE COALESCE(nullif(lower(ro.revoked_reason), ''), 'cancelled')
              END AS cancellation_reason_code,
              NULL::text AS cancelled_by,
              NULL::text AS cancelled_by_role,
              NULL::text AS financial_outcome,
              sa.name AS service_area_label,
              sa.name AS pickup_area_label,
              sa.name AS dropoff_area_label,
              COALESCE(t.total_stops, 1) AS total_stops,
              COALESCE(ro.offered_at, ro.created_at) AS requested_at,
              NULL::timestamptz AS pickup_at,
              NULL::timestamptz AS dropoff_at,
              COALESCE(ro.responded_at, ro.updated_at, ro.expires_at, ro.created_at) AS cancelled_at,
              NULL::timestamptz AS closed_at,
              COALESCE(
                ro.driver_offer_fare,
                NULLIF(ro.offer_snapshot->>'driver_net_fare_pence', '')::int,
                NULLIF(ro.offer_snapshot->>'driver_earnings_pence', '')::int,
                NULLIF(ro.offer_snapshot->>'driver_net_preview_pence', '')::int
              ) AS payable_amount_pence,
              false AS has_card_payment_record,
              t.payment_method,
              t.booking_type,
              t.vehicle_type,
              COALESCE(ro.responded_at, ro.updated_at, ro.expires_at, ro.created_at) AS sort_at,
              false AS is_active,
              2 AS source_pri
            FROM public.ride_offers ro
            INNER JOIN public.trips t ON t.id = ro.trip_id
            LEFT JOIN public.service_areas sa ON sa.id = t.service_area_id
            WHERE ro.driver_id = v_driver_id
              AND (
                p_trip_id IS NULL
                OR ro.trip_id = p_trip_id
              )
              AND (
                v_tab IS NULL
                OR v_tab = 'cancelled'
              )
              AND lower(COALESCE(ro.status, '')) IN ('declined', 'expired', 'revoked')
              AND (
                lower(ro.status) IN ('declined', 'expired')
                OR lower(COALESCE(ro.revoked_reason, '')) IN (
                  'another_offer_accepted',
                  'passenger_cancelled',
                  'trip_cancelled',
                  'trip_terminal_cancel',
                  'cancelled_by_admin',
                  'admin_cancelled',
                  'trip_expired_no_driver'
                )
              )
              AND NOT (
                t.driver_id = v_driver_id
                OR t.confirmed_driver_id = v_driver_id
                OR t.previous_driver_id = v_driver_id
                OR (t.cancelled_driver_ids IS NOT NULL AND t.cancelled_driver_ids @> ARRAY[v_driver_id])
              )
              AND (p_before IS NULL OR COALESCE(
                ro.responded_at, ro.updated_at, ro.expires_at, ro.created_at
              ) < p_before)
          ) combined
          ORDER BY combined.id, combined.source_pri ASC, combined.sort_at DESC
        ) deduped
        ORDER BY deduped.sort_at DESC
        LIMIT CASE WHEN p_trip_id IS NOT NULL THEN 1 ELSE v_limit END
      ) row
    ),
    '[]'::jsonb
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.list_driver_own_trip_history(integer, timestamptz, text, uuid)
  TO authenticated, service_role;

-- 4) Recreate views without stripe_* dependencies
DROP VIEW IF EXISTS public.available_scheduled_jobs;
CREATE VIEW public.available_scheduled_jobs AS
SELECT id,
    passenger_id,
    passenger_name,
    passenger_phone,
    driver_id,
    confirmed_driver_id,
    pickup_address,
    pickup_latitude,
    pickup_longitude,
    dropoff_address,
    dropoff_latitude,
    dropoff_longitude,
    stops,
    fare,
    estimated_fare,
    estimated_distance_km,
    estimated_duration_minutes,
    surge_multiplier,
    currency,
    currency_code,
    payment_method,
    payment_type,
    payment_status,
    status,
    trip_type,
    trip_code,
    job_type,
    special_instructions,
    is_scheduled,
    scheduled_at,
    client_action_id,
    created_at,
    updated_at,
    started_at,
    completed_at,
    driver_location_lat,
    driver_location_lng,
    total_stops,
    current_stop_index,
    scheduled_status,
    dispatch_mode,
    scheduled_broadcast_at,
    scheduled_convert_at,
    confirm_deadline_at,
    pre_assigned_driver_id,
    driver_confirm_deadline_at,
    escalation_status,
    pickup_zone_id,
    dropoff_zone_id,
    service_area_id,
    dispatch_status,
    current_broadcast_round,
    max_broadcast_rounds,
    broadcast_started_at,
    last_broadcast_at,
    service_area_code,
    sequence_no,
    trip_number,
    arrived_at,
    vehicle_type,
    gross_fare_pence,
    commission_pence,
    driver_net_pence,
    scheduled_accepted_at,
    check_in_reminder_sent_at,
    current_offer_driver_id,
    current_offer_expires_at,
    COALESCE(( SELECT count(*) AS count
           FROM scheduled_offer_attempts
          WHERE scheduled_offer_attempts.trip_id = t.id AND (scheduled_offer_attempts.status = ANY (ARRAY['declined'::text, 'timeout'::text]))), 0::bigint) AS declined_count
   FROM trips t
  WHERE dispatch_mode = 'scheduled'::text AND (scheduled_status = ANY (ARRAY['broadcasting'::text, 'scheduled'::text, 'awaiting_confirmation'::text])) AND driver_id IS NULL AND confirmed_driver_id IS NULL AND scheduled_at > now() AND (status <> ALL (ARRAY['completed'::text, 'cancelled'::text, 'customer_cancelled'::text, 'driver_cancelled'::text, 'no_show'::text, 'expired'::text, 'expired_no_driver'::text]));;

-- driver_financial_summary rewritten without d.stripe_account_id (NULL alias retained for API shape)
CREATE OR REPLACE VIEW public.driver_financial_summary AS
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
    AND dwl.type <> ALL (ARRAY['LEDGER_REVERSAL'::text, 'COMMISSION_RECOVERED'::text])
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
      CASE WHEN type <> ALL (ARRAY[
        'PLATFORM_COMMISSION'::text,
        'CASH_TRIP_EARNING'::text,
        'PAYOUT_RESERVATION_HOLD'::text,
        'PAYOUT_RESERVATION_RELEASE'::text
      ]) THEN amount_pence ELSE 0 END
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
),
reserved_payout_totals AS (
  SELECT
    driver_id,
    COALESCE(SUM(amount_pence), 0)::bigint AS reserved_payout_pence
  FROM driver_payout_reservations
  WHERE status = 'ACTIVE'
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
  NULL::text AS stripe_account_id,
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
  GREATEST(
    COALESCE(bt.wallet_balance, 0::bigint)
      - COALESCE(rc.reserved_cashout_pence, 0::bigint)
      - COALESCE(rp.reserved_payout_pence, 0::bigint),
    0::bigint
  )                                                          AS available_for_payout,
  COALESCE(rc.reserved_cashout_pence, 0::bigint)
    + COALESCE(rp.reserved_payout_pence, 0::bigint)          AS reserved_cashout_pence,
  GREATEST(
    COALESCE(bt.wallet_balance, 0::bigint)
      - COALESCE(rc.reserved_cashout_pence, 0::bigint)
      - COALESCE(rp.reserved_payout_pence, 0::bigint),
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
  LEFT JOIN reserved_cashout_totals rc ON rc.driver_id = d.id
  LEFT JOIN reserved_payout_totals rp ON rp.driver_id = d.id;

CREATE OR REPLACE VIEW public.v_finance_era_marker
WITH (security_invoker = on) AS
SELECT
  (SELECT setting_value::text FROM public.admin_settings WHERE setting_key = 'finance_era') AS era,
  (SELECT (setting_value #>> '{}')::timestamptz FROM public.admin_settings WHERE setting_key = 'finance_era_started_at') AS started_at;

-- Drop era views before dropping ledger stripe_* columns (SELECT * dependency)
DROP VIEW IF EXISTS public.v_finance_era_legacy_cash;
DROP VIEW IF EXISTS public.v_finance_era_digital;

-- 5) Drop Stripe-only tables / functions
DROP TABLE IF EXISTS public.processed_stripe_events CASCADE;
DROP TABLE IF EXISTS public.stripe_connect_payouts CASCADE;
DROP TABLE IF EXISTS public.stripe_connect_payout_schedule_audit CASCADE;
DROP TABLE IF EXISTS public.stripe_connect_account_cache CASCADE;
DROP TABLE IF EXISTS public.stripe_connect_balance_cache CASCADE;
DROP TABLE IF EXISTS public.stripe_connect_audit_events CASCADE;
DROP FUNCTION IF EXISTS public.sync_stripe_connect_payouts() CASCADE;
DROP FUNCTION IF EXISTS public.process_stripe_webhook_event(jsonb) CASCADE;

-- 6) Drop stripe_* columns
ALTER TABLE public.trips
  DROP COLUMN IF EXISTS stripe_payment_intent_id,
  DROP COLUMN IF EXISTS stripe_charge_id,
  DROP COLUMN IF EXISTS stripe_refund_id,
  DROP COLUMN IF EXISTS stripe_application_fee_id,
  DROP COLUMN IF EXISTS stripe_application_fee_amount_pence,
  DROP COLUMN IF EXISTS stripe_destination_account_id,
  DROP COLUMN IF EXISTS stripe_transfer_id,
  DROP COLUMN IF EXISTS stripe_transfer_amount_pence,
  DROP COLUMN IF EXISTS stripe_processing_fee_pence,
  DROP COLUMN IF EXISTS stripe_fee_amount,
  DROP COLUMN IF EXISTS stripe_settlement_verified,
  DROP COLUMN IF EXISTS stripe_settlement_warning;

ALTER TABLE public.payments
  DROP COLUMN IF EXISTS stripe_payment_intent_id,
  DROP COLUMN IF EXISTS stripe_charge_id,
  DROP COLUMN IF EXISTS stripe_refund_id,
  DROP COLUMN IF EXISTS stripe_fee_pence,
  DROP COLUMN IF EXISTS stripe_application_fee_amount,
  DROP COLUMN IF EXISTS driver_stripe_account_id;

ALTER TABLE public.orphan_payments
  DROP COLUMN IF EXISTS stripe_payment_intent_id;

ALTER TABLE public.drivers
  DROP COLUMN IF EXISTS stripe_account_id;

ALTER TABLE public.customers
  DROP COLUMN IF EXISTS stripe_customer_id;

ALTER TABLE public.driver_wallet_ledger
  DROP COLUMN IF EXISTS stripe_payout_id,
  DROP COLUMN IF EXISTS stripe_transfer_id,
  DROP COLUMN IF EXISTS stripe_balance_transaction_id;

ALTER TABLE public.payout_items
  DROP COLUMN IF EXISTS stripe_payout_id,
  DROP COLUMN IF EXISTS stripe_transfer_id,
  DROP COLUMN IF EXISTS stripe_fee_pence,
  DROP COLUMN IF EXISTS stripe_instant_available_before_pence,
  DROP COLUMN IF EXISTS stripe_method,
  DROP COLUMN IF EXISTS driver_stripe_account_id;

ALTER TABLE public.driver_earning_settlement
  DROP COLUMN IF EXISTS stripe_available_on,
  DROP COLUMN IF EXISTS stripe_balance_tx_id,
  DROP COLUMN IF EXISTS stripe_charge_id,
  DROP COLUMN IF EXISTS stripe_transfer_id;

ALTER TABLE public.driver_early_cashouts
  DROP COLUMN IF EXISTS stripe_fee_pence,
  DROP COLUMN IF EXISTS stripe_instant_available_before_pence,
  DROP COLUMN IF EXISTS stripe_method,
  DROP COLUMN IF EXISTS stripe_payout_id,
  DROP COLUMN IF EXISTS stripe_transfer_id;

ALTER TABLE public.trip_finance
  DROP COLUMN IF EXISTS stripe_application_fee_id,
  DROP COLUMN IF EXISTS stripe_destination_account_id,
  DROP COLUMN IF EXISTS stripe_payment_intent_id,
  DROP COLUMN IF EXISTS stripe_processing_fee_pence;

ALTER TABLE public.admin_payment_audit
  DROP COLUMN IF EXISTS stripe_payment_intent_id,
  DROP COLUMN IF EXISTS stripe_refund_id;

ALTER TABLE public.customer_wallet_ledger
  DROP COLUMN IF EXISTS stripe_payment_intent_id;

ALTER TABLE public.payment_authorization_ledger
  DROP COLUMN IF EXISTS stripe_payment_intent_id;

ALTER TABLE public.finance_reconciliation_notes
  DROP COLUMN IF EXISTS stripe_payout_id,
  DROP COLUMN IF EXISTS stripe_payout_amount_pence;

ALTER TABLE public.merchant_ai_credit_history
  DROP COLUMN IF EXISTS stripe_payment_id;

-- Recreate era views AFTER ledger stripe columns are gone
CREATE OR REPLACE VIEW public.v_finance_era_legacy_cash
WITH (security_invoker = on) AS
SELECT l.*
FROM public.driver_wallet_ledger l
LEFT JOIN public.v_finance_era_marker m ON true
WHERE m.started_at IS NULL OR l.created_at < m.started_at;

CREATE OR REPLACE VIEW public.v_finance_era_digital
WITH (security_invoker = on) AS
SELECT l.*
FROM public.driver_wallet_ledger l
JOIN public.v_finance_era_marker m ON true
WHERE m.started_at IS NOT NULL AND l.created_at >= m.started_at;

GRANT SELECT ON public.v_finance_era_marker TO authenticated;
GRANT SELECT ON public.v_finance_era_legacy_cash TO authenticated;
GRANT SELECT ON public.v_finance_era_digital TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.available_scheduled_jobs TO anon, authenticated, service_role;

COMMIT;
