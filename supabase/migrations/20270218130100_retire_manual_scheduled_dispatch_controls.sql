-- ============================================================
-- Retire staff-invokable manual Scheduled Dispatch controls:
--   make_available_now / make_available_at
--   broadcast_now / broadcast_at
--   hold_exceptional
--
-- Marketplace publication + fallback convert/broadcast remain automatic
-- (CTAP post-commit, scheduled-dispatch STEP 0b, convert_at).
-- Assign Driver + Cancel Ride stay available for exceptional intervention.
--
-- Blocks both Edge and direct RPC (authenticated) invocation.
-- NOT APPLIED until explicit production approval.
-- ============================================================

DO $patch$
DECLARE
  v_def text;
  v_marker text :=
$m$
  IF char_length(v_reason) < 3 THEN
    RETURN jsonb_build_object('success', false, 'error', 'REASON_REQUIRED');
  END IF;

  -- Staff JWT path: enforce page + action. Service-role trusted after Edge RBAC.
$m$;
  v_inject text :=
$inj$
  IF char_length(v_reason) < 3 THEN
    RETURN jsonb_build_object('success', false, 'error', 'REASON_REQUIRED');
  END IF;

  -- Retired: staff must not manually Broadcast / Make Available / Hold.
  -- Automatic publication + fallback dispatch own those transitions.
  IF v_action IN (
    'make_available_now',
    'make_available_at',
    'broadcast_now',
    'broadcast_at',
    'hold_exceptional'
  ) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'RETIRED_MANUAL_SCHEDULED_CONTROL',
      'message',
        'Manual Broadcast / Make Available / Hold are retired. '
        || 'Scheduled Jobs publication and fallback dispatch are automatic.'
    );
  END IF;

  -- Staff JWT path: enforce page + action. Service-role trusted after Edge RBAC.
$inj$;
BEGIN
  SELECT pg_get_functiondef(
    'public.admin_scheduled_emergency_mutate(text,uuid,uuid,text,jsonb,jsonb)'::regprocedure
  ) INTO v_def;
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'admin_scheduled_emergency_mutate missing — cannot retire manual controls';
  END IF;
  IF position('RETIRED_MANUAL_SCHEDULED_CONTROL' in v_def) > 0 THEN
    RAISE NOTICE 'admin_scheduled_emergency_mutate already retires manual scheduled controls';
    RETURN;
  END IF;
  IF position(v_marker in v_def) = 0 THEN
    RAISE EXCEPTION 'admin_scheduled_emergency_mutate retirement patch marker not found — abort';
  END IF;
  v_def := replace(v_def, v_marker, v_inject);
  EXECUTE v_def;
END;
$patch$;
