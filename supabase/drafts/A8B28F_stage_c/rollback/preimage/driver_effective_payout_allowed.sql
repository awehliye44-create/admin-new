CREATE OR REPLACE FUNCTION public.driver_effective_payout_allowed(p_driver_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_global boolean := true;
  v_paused boolean := false;
  v_legacy boolean := false;
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
    coalesce(d.payouts_enabled, false),
    lower(coalesce(d.approval_status, '')) IN ('approved', 'active'),
    lower(d.driver_status::text) IN ('suspended', 'banned', 'blocked', 'inactive')
  INTO v_paused, v_legacy, v_approved, v_suspended
  FROM public.drivers d
  WHERE d.id = p_driver_id;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  v_provider := public.driver_has_provider_verified_payout_destination(p_driver_id);

  -- Stage A fail-closed: ALL conjuncts required, including legacy payouts_enabled.
  -- Stage C will drop the legacy conjunct only after Stage B cutover is live.
  IF NOT v_global THEN RETURN false; END IF;
  IF v_suspended THEN RETURN false; END IF;
  IF NOT v_approved THEN RETURN false; END IF;
  IF v_paused THEN RETURN false; END IF;
  IF v_legacy IS NOT TRUE THEN RETURN false; END IF;
  IF NOT v_provider THEN RETURN false; END IF;
  RETURN true;
END;
$function$;
