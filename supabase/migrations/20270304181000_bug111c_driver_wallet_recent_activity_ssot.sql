-- #111C — Driver Wallet recent Activity SSOT (SECURITY DEFINER).
-- Balances already come from get_driver_own_wallet_summary. Recent Activity used a
-- direct PostgREST select on driver_wallet_ledger + a separate trips SELECT that
-- requires onecab_jwt_access_role()='driver'. When access_role bind lags, trip
-- meta is empty; when the ledger select errors, the client swallowed to [].
-- This RPC returns ledger rows with embedded trip presentation, durable
-- earning_category, and clearing_status so Activity cannot permanently hide a
-- successfully posted TEN (including no-show / terminal fees still in 27h clearing).
-- Does not change balances, clearing delay, or ledger amounts.

BEGIN;

CREATE OR REPLACE FUNCTION public.get_driver_own_wallet_recent_activity(
  p_limit integer DEFAULT 20,
  p_before timestamptz DEFAULT NULL
)
RETURNS TABLE(
  ledger_entry_id uuid,
  type text,
  amount_pence bigint,
  related_trip_id uuid,
  created_at timestamptz,
  description text,
  metadata jsonb,
  economic_earned_at timestamptz,
  clearing_status text,
  public_trip_ref text,
  financial_outcome text,
  trip_status text,
  airport_charge_pence integer,
  earning_category text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_role text := public.driver_wallet_jwt_role();
  v_driver_id uuid;
  v_limit integer := GREATEST(1, LEAST(COALESCE(p_limit, 20), 100));
BEGIN
  IF v_role IS DISTINCT FROM 'authenticated' THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  v_driver_id := public.current_driver_id();
  IF v_driver_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    dwl.id::uuid AS ledger_entry_id,
    dwl.type::text AS type,
    dwl.amount_pence::bigint AS amount_pence,
    dwl.related_trip_id::uuid AS related_trip_id,
    dwl.created_at,
    dwl.description::text AS description,
    dwl.metadata AS metadata,
    r.economic_earned_at,
    r.clearing_status::text AS clearing_status,
    NULLIF(btrim(COALESCE(t.trip_code, t.trip_number, '')), '')::text AS public_trip_ref,
    t.financial_outcome::text AS financial_outcome,
    t.status::text AS trip_status,
    COALESCE(t.airport_charge_pence, 0)::integer AS airport_charge_pence,
    COALESCE(
      NULLIF(lower(btrim(COALESCE(dwl.metadata->>'earning_category', ''))), ''),
      CASE
        WHEN upper(COALESCE(t.financial_outcome, '')) = 'NO_SHOW'
          OR lower(COALESCE(t.status, '')) IN ('no_show', 'noshow', 'passenger_no_show')
          OR dwl.description ~* 'no[[:space:]-]?show'
          THEN 'no_show_earning'
        WHEN upper(COALESCE(t.financial_outcome, '')) = 'ARRIVAL_CANCELLATION'
          OR dwl.description ~* 'arrival[[:space:]]+cancellation'
          THEN 'arrival_cancellation_earning'
        WHEN upper(COALESCE(t.financial_outcome, '')) = 'LATE_PASSENGER_CANCELLATION'
          OR dwl.description ~* 'late[[:space:]]+passenger[[:space:]]+cancellation'
          THEN 'late_cancellation_earning'
        WHEN upper(COALESCE(t.financial_outcome, '')) = 'CANCELLED_WITH_FEE'
          OR dwl.description ~* 'cancellation[[:space:]]+compensation'
          THEN 'other_cancellation_earning'
        WHEN upper(dwl.type) = 'TRIP_EARNING_NET' THEN 'normal_trip_earning'
        ELSE NULL
      END
    )::text AS earning_category
  FROM public.driver_wallet_ledger dwl
  CROSS JOIN LATERAL public.driver_wallet_resolve_economic_date(
    dwl.type, dwl.related_trip_id, dwl.created_at
  ) r
  LEFT JOIN public.trips t ON t.id = dwl.related_trip_id
  WHERE dwl.driver_id = v_driver_id
    AND dwl.type IN (
      'TRIP_EARNING_NET',
      'TRIP_EARNING_PENDING',
      'TRIP_EARNING_PENDING_RELEASE',
      'DRIVER_TIP_CREDIT',
      'NO_SHOW_FEE',
      'BONUS',
      'MANUAL_ADJUSTMENT',
      'MANUAL_CREDIT',
      'MANUAL_DEBIT',
      'ADJUSTMENT',
      'EARLY_CASHOUT',
      'CASHOUT_FEE',
      'WEEKLY_PAYOUT',
      'MANUAL_PAYOUT',
      'PAYOUT',
      'PAYOUT_FAILED_RETURN',
      'PAYOUT_REVERSAL',
      'DEBT_RECOVERY',
      'REFUND_DEBIT'
    )
    AND (p_before IS NULL OR dwl.created_at < p_before)
  ORDER BY dwl.created_at DESC
  LIMIT v_limit;
END;
$function$;

COMMENT ON FUNCTION public.get_driver_own_wallet_recent_activity(integer, timestamptz) IS
  '#111C Wallet Activity SSOT: own ledger recent rows with trip presentation, earning_category, clearing_status. SECURITY DEFINER; authenticated driver only.';

REVOKE ALL ON FUNCTION public.get_driver_own_wallet_recent_activity(integer, timestamptz)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_driver_own_wallet_recent_activity(integer, timestamptz)
  TO authenticated;

COMMIT;
