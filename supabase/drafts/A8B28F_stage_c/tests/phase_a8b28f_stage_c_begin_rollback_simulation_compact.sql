-- Compact A8B28F Stage C BEGIN/ROLLBACK simulation
BEGIN;

CREATE OR REPLACE FUNCTION public.assert_driver_wallet_read_access(p_driver_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  RETURN;
END;
$function$;

CREATE OR REPLACE FUNCTION public.driver_effective_payout_allowed(p_driver_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
DECLARE
  v_global boolean := true;
  v_paused boolean := false;
  v_approved boolean := false;
  v_suspended boolean := false;
  v_provider boolean := false;
  v_setting text;
BEGIN
  IF p_driver_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT setting_value::text
  INTO v_setting
  FROM public.admin_settings
  WHERE setting_key = 'payouts_enabled'
  LIMIT 1;
  v_global := lower(coalesce(v_setting, 'true')) IS DISTINCT FROM 'false';

  SELECT
    coalesce(d.payout_operational_paused, false),
    lower(coalesce(d.approval_status, '')) IN ('approved', 'active'),
    lower(d.driver_status::text) IN ('disabled', 'deleted', 'suspended', 'banned', 'blocked', 'inactive')
  INTO v_paused, v_approved, v_suspended
  FROM public.drivers d
  WHERE d.id = p_driver_id;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  v_provider := public.driver_has_provider_verified_payout_destination(p_driver_id);

  -- A8B28F Stage C: drop legacy drivers.payouts_enabled conjunct.
  -- effective = global AND NOT suspended AND approved AND NOT operational_paused AND provider_verified.
  IF NOT v_global THEN RETURN false; END IF;
  IF v_suspended THEN RETURN false; END IF;
  IF NOT v_approved THEN RETURN false; END IF;
  IF v_paused THEN RETURN false; END IF;
  IF NOT v_provider THEN RETURN false; END IF;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.driver_wallet_eligibility_balances(p_driver_id uuid)
 RETURNS TABLE(live_balance_pence bigint, available_balance_pence bigint, pending_balance_pence bigint, withdrawal_in_progress_pence bigint, outstanding_debt_pence bigint, eligible_earnings_pence bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_live bigint := 0;
  v_debt bigint := 0;
  v_reserved bigint := 0;
  v_in_flight bigint := 0;
  v_withdrawal bigint := 0;
  v_eligible bigint := 0;
  v_pending bigint := 0;
  v_unpaid_eligible bigint := 0;
  v_available bigint := 0;
  v_delay_hours numeric := 48;
  v_operational_paused boolean := false;
  r record;
  v_captured bigint;
  v_canonical bigint;
  v_refunded bigint;
  v_session_status text;
  v_allocated bigint;
  v_unpaid bigint;
  v_model text;
  v_method text;
  v_requires_clearing boolean;
  v_cleared boolean;
  v_origin timestamptz;
  v_first_captured timestamptz;
BEGIN
  PERFORM public.assert_driver_wallet_read_access(p_driver_id);

  v_live := public.driver_wallet_live_balance_pence(p_driver_id);
  v_reserved := public.driver_wallet_active_reservation_pence(p_driver_id);
  v_in_flight := public.driver_wallet_other_holds_pence(p_driver_id);
  v_withdrawal := GREATEST(0, v_reserved) + GREATEST(0, v_in_flight);
  v_delay_hours := public.driver_wallet_payout_clearing_delay_hours();

  SELECT COALESCE(payout_operational_paused, false)
  INTO v_operational_paused
  FROM public.drivers
  WHERE id = p_driver_id;

  SELECT GREATEST(
    0,
    COALESCE(SUM(CASE WHEN type = 'CASH_COMMISSION_DEBT' THEN abs(amount_pence) ELSE 0 END), 0)
    - COALESCE(SUM(CASE WHEN type = 'DEBT_RECOVERY' THEN abs(amount_pence) ELSE 0 END), 0)
  )::bigint
  INTO v_debt
  FROM public.driver_wallet_ledger
  WHERE driver_id = p_driver_id;

  -- A8B28F Stage C: operational pause zeros Available; verification does NOT.
  IF v_operational_paused IS TRUE THEN
    RETURN QUERY SELECT
      v_live,
      0::bigint,
      GREATEST(0, v_live)::bigint,
      v_withdrawal,
      GREATEST(0, v_debt)::bigint,
      0::bigint;
    RETURN;
  END IF;

  FOR r IN
    SELECT
      l.id AS ledger_id,
      l.type,
      l.amount_pence,
      l.related_trip_id,
      l.created_at,
      t.payment_collection_model::text AS payment_collection_model,
      t.financial_model::text AS financial_model,
      t.payment_method AS trip_payment_method,
      t.status::text AS trip_status,
      t.cancelled_at AS trip_cancelled_at,
      t.completed_at AS trip_completed_at,
      t.driver_net_pence,
      t.tip_pence,
      t.tip_amount_pence,
      t.provider_available_on AS trip_provider_available_on,
      ps.id AS session_id,
      ps.captured_amount_pence,
      ps.captured_at,
      ps.metadata AS session_metadata,
      ps.refunded_amount_pence,
      ps.status::text AS session_status,
      ps.provider_state,
      ps.payment_method AS session_payment_method,
      des.settled_at,
      des.settlement_status,
      des.provider_available_on AS des_provider_available_on,
      des.capture_time,
      des.allocated_to_payout,
      des.allocated_amount_pence,
      des.paid_in_batch_id,
      des.paid_in_payout_item_id,
      COALESCE(alloc.allocated_sum, 0)::bigint AS alloc_sum
    FROM public.driver_wallet_ledger l
    LEFT JOIN public.trips t ON t.id = l.related_trip_id
    LEFT JOIN LATERAL (
      SELECT s.*
      FROM public.payment_sessions s
      WHERE s.id = t.payment_session_id
         OR s.trip_id = t.id
      ORDER BY COALESCE(s.captured_amount_pence, 0) DESC, s.captured_at DESC NULLS LAST
      LIMIT 1
    ) ps ON true
    LEFT JOIN LATERAL (
      SELECT d.*
      FROM public.driver_earning_settlement d
      WHERE d.ledger_entry_id = l.id
      ORDER BY d.updated_at DESC NULLS LAST
      LIMIT 1
    ) des ON true
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(a.amount_pence), 0) AS allocated_sum
      FROM public.payout_item_ledger_allocations a
      INNER JOIN public.payout_items pi ON pi.id = a.payout_item_id
      WHERE a.ledger_entry_id = l.id
        AND NOT public.payout_item_status_releases_ledger_allocation(pi.status, pi.execution_status)
    ) alloc ON true
    WHERE l.driver_id = p_driver_id
      AND l.type IN ('TRIP_EARNING_NET', 'DRIVER_TIP_CREDIT', 'TIP_CREDIT')
      AND l.amount_pence > 0
  LOOP
    IF r.paid_in_batch_id IS NOT NULL
       OR r.allocated_to_payout IS TRUE
       OR r.paid_in_payout_item_id IS NOT NULL THEN
      CONTINUE;
    END IF;

    v_allocated := GREATEST(
      COALESCE(r.alloc_sum, 0),
      COALESCE(r.allocated_amount_pence, 0)
    );
    v_unpaid := GREATEST(0, r.amount_pence - v_allocated);
    IF v_unpaid <= 0 THEN
      CONTINUE;
    END IF;

    IF r.related_trip_id IS NULL THEN
      CONTINUE;
    END IF;
    IF r.trip_cancelled_at IS NOT NULL THEN
      CONTINUE;
    END IF;
    IF lower(COALESCE(r.trip_status, '')) LIKE '%cancel%' THEN
      CONTINUE;
    END IF;
    IF lower(btrim(COALESCE(r.trip_status, ''))) <> 'completed'
       AND r.trip_completed_at IS NULL THEN
      CONTINUE;
    END IF;

    v_session_status := lower(COALESCE(r.session_status::text, ''));
    v_refunded := GREATEST(0, COALESCE(r.refunded_amount_pence, 0));
    IF v_refunded > 0
       OR v_session_status LIKE '%refund%'
       OR v_session_status LIKE '%chargeback%'
       OR v_session_status LIKE '%dispute%'
       OR v_session_status LIKE '%cancel%'
       OR v_session_status LIKE '%void%'
       OR lower(COALESCE(r.provider_state, '')) IN ('cancelled', 'canceled', 'failed', 'void') THEN
      CONTINUE;
    END IF;

    v_captured := CASE
      WHEN r.captured_amount_pence IS NULL THEN NULL
      ELSE round(r.captured_amount_pence)::bigint
    END;

    IF r.session_id IS NULL OR v_captured IS NULL OR v_captured <= 0 THEN
      CONTINUE;
    END IF;

    IF upper(r.type) = 'TRIP_EARNING_NET' THEN
      v_canonical := GREATEST(0, COALESCE(r.driver_net_pence, 0));
    ELSE
      v_canonical := GREATEST(0, COALESCE(r.tip_pence, r.tip_amount_pence, 0));
    END IF;

    IF v_canonical <= 0 OR r.amount_pence <> v_canonical THEN
      CONTINUE;
    END IF;

    IF v_captured < v_canonical THEN
      CONTINUE;
    END IF;

    v_model := upper(btrim(COALESCE(
      r.payment_collection_model::text,
      r.financial_model::text,
      'PLATFORM_COLLECTED'
    )));
    v_method := lower(btrim(COALESCE(r.trip_payment_method, r.session_payment_method, '')));
    v_requires_clearing := (v_model NOT LIKE '%DRIVER_COLLECTED%')
      AND v_method NOT LIKE '%cash%';

    v_cleared := NOT v_requires_clearing;
    IF v_requires_clearing THEN
      IF COALESCE(r.des_provider_available_on, r.trip_provider_available_on) IS NOT NULL
         AND COALESCE(r.des_provider_available_on, r.trip_provider_available_on) <= now() THEN
        v_cleared := true;
      ELSIF public.driver_wallet_provider_funds_cleared(r.provider_state) THEN
        v_cleared := true;
      ELSE
        v_first_captured := NULL;
        IF r.session_metadata IS NOT NULL
           AND jsonb_typeof(r.session_metadata) = 'object'
           AND NULLIF(btrim(r.session_metadata->>'first_captured_at'), '') IS NOT NULL THEN
          BEGIN
            v_first_captured := (r.session_metadata->>'first_captured_at')::timestamptz;
          EXCEPTION WHEN OTHERS THEN
            v_first_captured := NULL;
          END;
        END IF;

        v_origin := public.driver_wallet_stable_clearing_origin(
          r.captured_at,
          r.trip_completed_at,
          r.capture_time,
          r.created_at,
          v_first_captured
        );
        IF v_origin IS NOT NULL
           AND (v_origin + (v_delay_hours * interval '1 hour')) <= now() THEN
          v_cleared := true;
        END IF;
      END IF;
    END IF;

    IF v_cleared THEN
      v_eligible := v_eligible + v_unpaid;
    ELSE
      v_pending := v_pending + v_unpaid;
    END IF;
  END LOOP;

  v_unpaid_eligible := LEAST(
    GREATEST(0, v_eligible),
    GREATEST(0, GREATEST(0, v_live) - GREATEST(0, v_pending))
  );
  v_available := GREATEST(
    0,
    v_unpaid_eligible - GREATEST(0, v_debt) - v_withdrawal
  );

  RETURN QUERY SELECT
    v_live,
    v_available,
    GREATEST(0, v_pending)::bigint,
    v_withdrawal,
    GREATEST(0, v_debt)::bigint,
    GREATEST(0, v_unpaid_eligible)::bigint;
END;
$function$;

DO $sim$
DECLARE
  v_mk uuid := 'c40dd8a6-f422-40bc-9534-bae7be88b93e';
  v_dest uuid := 'bc707ca9-7036-4885-a010-1e35903444a9';
  v_session uuid := '5323d380-fc65-4e90-9a1a-624035d3b3bf';
  v_live bigint; v_avail bigint; v_pend bigint;
  v_eff boolean; v_block text;
  v_ledger_n int;
  v_setting_before jsonb;
  v_link_before text;
  v_ver_before text;
  v_cp_before text;
  v_rc_before text;
  v_op_before boolean;
  v_status_before text;
  v_approval_before text;
  v_captured_before timestamptz;
  v_trip_completed_before timestamptz;
  v_ledger_created_before timestamptz;
  v_trip uuid := '55560d22-2f3f-4ad4-8232-d965a91d7975';
  v_early_enabled boolean;
  v_global boolean;
  v_dest_verified boolean;
  r record;
BEGIN
  SELECT count(*) INTO v_ledger_n FROM public.driver_wallet_ledger WHERE driver_id = v_mk;

  SELECT setting_value INTO v_setting_before FROM public.admin_settings WHERE setting_key='payouts_enabled' LIMIT 1;
  SELECT provider_link_status, verification_status,
         provider_counterparty_id, provider_recipient_account_id
  INTO v_link_before, v_ver_before, v_cp_before, v_rc_before
  FROM public.driver_payout_destinations WHERE id = v_dest;
  SELECT payout_operational_paused, driver_status::text, approval_status
  INTO v_op_before, v_status_before, v_approval_before
  FROM public.drivers WHERE id = v_mk;
  SELECT captured_at INTO v_captured_before FROM public.payment_sessions WHERE id = v_session;
  SELECT completed_at INTO v_trip_completed_before FROM public.trips WHERE id = v_trip;
  SELECT coalesce(sa.early_cashout_enabled,false) INTO v_early_enabled
  FROM public.drivers d LEFT JOIN public.service_areas sa ON sa.id=d.service_area_id
  WHERE d.id=v_mk;

  SELECT b.live_balance_pence, b.available_balance_pence, b.pending_balance_pence
  INTO v_live, v_avail, v_pend FROM public.driver_wallet_eligibility_balances(v_mk) b;
  v_eff := public.driver_effective_payout_allowed(v_mk);
  IF v_avail IS DISTINCT FROM 425 OR v_pend IS DISTINCT FROM 0 OR v_eff IS NOT TRUE THEN
    RAISE EXCEPTION 'sim A fail avail=% pend=% eff=% live=%', v_avail, v_pend, v_eff, v_live;
  END IF;
  IF v_early_enabled IS NOT TRUE OR NOT (v_avail > 50) THEN RAISE EXCEPTION 'sim A early/fee fail'; END IF;
  RAISE NOTICE 'SIM_A_OK';

  UPDATE public.driver_payout_destinations
  SET provider_link_status='FAILED', verification_status='PENDING_VERIFICATION',
      provider_counterparty_id=NULL, provider_recipient_account_id=NULL WHERE id=v_dest;
  SELECT b.available_balance_pence, b.pending_balance_pence INTO v_avail, v_pend
  FROM public.driver_wallet_eligibility_balances(v_mk) b;
  v_eff := public.driver_effective_payout_allowed(v_mk);
  IF v_avail IS DISTINCT FROM 425 OR v_pend IS DISTINCT FROM 0 OR v_eff IS TRUE THEN
    RAISE EXCEPTION 'sim B fail avail=% pend=% eff=%', v_avail, v_pend, v_eff;
  END IF;
  RAISE NOTICE 'SIM_B_OK';
  UPDATE public.driver_payout_destinations
  SET provider_link_status=v_link_before, verification_status=v_ver_before,
      provider_counterparty_id=v_cp_before, provider_recipient_account_id=v_rc_before
  WHERE id=v_dest;

  UPDATE public.drivers SET payout_operational_paused=true WHERE id=v_mk;
  SELECT b.available_balance_pence, b.pending_balance_pence INTO v_avail, v_pend
  FROM public.driver_wallet_eligibility_balances(v_mk) b;
  v_eff := public.driver_effective_payout_allowed(v_mk);
  IF v_avail IS DISTINCT FROM 0 OR v_pend IS DISTINCT FROM 425 OR v_eff IS TRUE THEN
    RAISE EXCEPTION 'sim C fail avail=% pend=% eff=%', v_avail, v_pend, v_eff;
  END IF;
  RAISE NOTICE 'SIM_C_OK';
  UPDATE public.drivers SET payout_operational_paused=v_op_before WHERE id=v_mk;

  -- Force uncleared: restamp all stable-origin candidates (MIN origin includes ledger created_at).
  SELECT created_at INTO v_ledger_created_before FROM public.driver_wallet_ledger WHERE id='28f67f6d-2826-4a70-bcb0-60b27b258621';
  UPDATE public.payment_sessions SET captured_at=now(), provider_state='AUTHORIZED' WHERE id=v_session;
  UPDATE public.trips SET completed_at=now() WHERE id=v_trip;
  UPDATE public.driver_wallet_ledger SET created_at=now() WHERE id='28f67f6d-2826-4a70-bcb0-60b27b258621';
  SELECT b.available_balance_pence, b.pending_balance_pence INTO v_avail, v_pend
  FROM public.driver_wallet_eligibility_balances(v_mk) b;
  IF v_avail IS DISTINCT FROM 0 OR v_pend IS DISTINCT FROM 425 THEN
    RAISE EXCEPTION 'sim D fail avail=% pend=%', v_avail, v_pend;
  END IF;
  RAISE NOTICE 'SIM_D_OK';
  UPDATE public.payment_sessions SET captured_at=v_captured_before, provider_state='COMPLETED' WHERE id=v_session;
  UPDATE public.trips SET completed_at=v_trip_completed_before WHERE id=v_trip;
  UPDATE public.driver_wallet_ledger SET created_at=v_ledger_created_before WHERE id='28f67f6d-2826-4a70-bcb0-60b27b258621';

  UPDATE public.admin_settings SET setting_value='false'::jsonb WHERE setting_key='payouts_enabled';
  SELECT b.available_balance_pence, b.pending_balance_pence INTO v_avail, v_pend
  FROM public.driver_wallet_eligibility_balances(v_mk) b;
  v_eff := public.driver_effective_payout_allowed(v_mk);
  IF v_avail IS DISTINCT FROM 425 OR v_pend IS DISTINCT FROM 0 OR v_eff IS TRUE THEN
    RAISE EXCEPTION 'sim E fail avail=% pend=% eff=%', v_avail, v_pend, v_eff;
  END IF;
  RAISE NOTICE 'SIM_E_OK';
  UPDATE public.admin_settings SET setting_value=coalesce(v_setting_before, 'true'::jsonb) WHERE setting_key='payouts_enabled';

  UPDATE public.drivers SET driver_status='disabled'::public.driver_status WHERE id=v_mk;
  v_eff := public.driver_effective_payout_allowed(v_mk);
  IF v_eff IS TRUE THEN RAISE EXCEPTION 'sim F fail'; END IF;
  RAISE NOTICE 'SIM_F_OK';
  UPDATE public.drivers SET driver_status=v_status_before::public.driver_status WHERE id=v_mk;

  UPDATE public.drivers SET approval_status='pending' WHERE id=v_mk;
  v_eff := public.driver_effective_payout_allowed(v_mk);
  IF v_eff IS TRUE THEN RAISE EXCEPTION 'sim G fail'; END IF;
  RAISE NOTICE 'SIM_G_OK';
  UPDATE public.drivers SET approval_status=v_approval_before WHERE id=v_mk;

  IF pg_get_functiondef('public.driver_wallet_eligibility_balances(uuid)'::regprocedure) NOT LIKE '%DRIVER_COLLECTED%' THEN
    RAISE EXCEPTION 'sim H fail';
  END IF;
  RAISE NOTICE 'SIM_H_OK';

  IF (SELECT count(*) FROM public.driver_wallet_ledger WHERE driver_id=v_mk) IS DISTINCT FROM v_ledger_n THEN
    RAISE EXCEPTION 'sim I count';
  END IF;
  IF (SELECT coalesce(sum(amount_pence),0) FROM public.driver_wallet_ledger WHERE driver_id=v_mk) IS DISTINCT FROM 425 THEN
    RAISE EXCEPTION 'sim I sum';
  END IF;
  RAISE NOTICE 'SIM_I_OK';

  SELECT lower(coalesce((SELECT setting_value::text FROM public.admin_settings WHERE setting_key='payouts_enabled' LIMIT 1),'true')) IS DISTINCT FROM 'false'
  INTO v_global;
  SELECT public.driver_has_provider_verified_payout_destination(v_mk) INTO v_dest_verified;
  SELECT * INTO r FROM public.drivers WHERE id=v_mk;
  IF lower(r.driver_status::text) IN ('disabled','deleted','suspended','banned','blocked','inactive') THEN v_block:='DRIVER_SUSPENDED';
  ELSIF lower(coalesce(r.approval_status,'')) NOT IN ('approved','active') THEN v_block:='DRIVER_NOT_APPROVED';
  ELSIF v_global IS NOT TRUE THEN v_block:='FEATURE_DISABLED';
  ELSIF coalesce(r.payout_operational_paused,false) THEN v_block:='ADMIN_HOLD';
  ELSIF NOT v_dest_verified THEN v_block:='PAYOUT_ACCOUNT_NOT_VERIFIED';
  ELSE v_block:=NULL; END IF;
  IF v_block IS NOT NULL THEN RAISE EXCEPTION 'sim J unexpected block %', v_block; END IF;
  RAISE NOTICE 'SIM_J_OK';

  RAISE NOTICE 'A8B28F_STAGE_C_SIMULATION_MATRIX_OK';
END;
$sim$;

ROLLBACK;
