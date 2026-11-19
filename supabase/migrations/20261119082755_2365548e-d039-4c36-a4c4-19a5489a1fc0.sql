DO $mig$
DECLARE
  v_def text;
  v_new text;
BEGIN
  -- 1. upsert_driver_presence: admin bypass must use user_roles (has_role), not legacy profiles.role.
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'upsert_driver_presence';
  v_new := replace(v_def,
    replace($s$~NL~     AND NOT EXISTS (~NL~       SELECT 1 FROM public.profiles p~NL~       WHERE p.user_id = auth.uid() AND p.role = 'admin'~NL~     )~NL~  THEN$s$, '~NL~', chr(10)),
    replace($s$~NL~     AND NOT public.has_role(auth.uid(), 'admin'::public.app_role)~NL~  THEN$s$, '~NL~', chr(10)));
  IF v_new = v_def THEN
    RAISE EXCEPTION 'upsert_driver_presence: legacy admin check not found';
  END IF;
  EXECUTE v_new;

  -- 2. record_driver_location_publish_diag (customer_client): match the rider via customers.user_id,
  --    and only attribute rows to that trip's own driver.
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'record_driver_location_publish_diag';
  v_new := replace(v_def,
    replace($s$        SELECT 1 FROM public.trips t~NL~        WHERE t.id = p_trip_id AND t.passenger_id = auth.uid()~NL~      ) THEN~NL~        RAISE EXCEPTION 'TRIP_ACCESS_DENIED' USING ERRCODE = 'P0001';~NL~      END IF;~NL~      v_driver_id := p_driver_id; -- optional; may be trip's driver$s$, '~NL~', chr(10)),
    replace($s$        SELECT 1 FROM public.trips t~NL~        JOIN public.customers c ON c.id = t.passenger_id~NL~        WHERE t.id = p_trip_id AND c.user_id = auth.uid()~NL~      ) THEN~NL~        RAISE EXCEPTION 'TRIP_ACCESS_DENIED' USING ERRCODE = 'P0001';~NL~      END IF;~NL~      -- Riders may only attribute rows to their own trip's driver.~NL~      SELECT CASE~NL~               WHEN p_driver_id IS NOT NULL AND p_driver_id IN (t.driver_id, t.confirmed_driver_id) THEN p_driver_id~NL~               ELSE COALESCE(t.driver_id, t.confirmed_driver_id)~NL~             END~NL~        INTO v_driver_id~NL~      FROM public.trips t WHERE t.id = p_trip_id;~NL~      IF p_driver_id IS NOT NULL AND p_driver_id IS DISTINCT FROM v_driver_id THEN~NL~        p_metadata := COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object('claimed_driver_id', p_driver_id);~NL~      END IF;$s$, '~NL~', chr(10)));
  IF v_new = v_def THEN
    RAISE EXCEPTION 'record_driver_location_publish_diag: customer_client check not found';
  END IF;
  EXECUTE v_new;

  -- 3. can_corporate_user_view_driver: signed-in callers may only ask about themselves.
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'can_corporate_user_view_driver';
  v_new := replace(v_def,
    replace($s$      AND cua.user_id = p_user_id~NL~$s$, '~NL~', chr(10)),
    replace($s$      AND cua.user_id = p_user_id~NL~      AND p_user_id IS NOT DISTINCT FROM auth.uid()~NL~$s$, '~NL~', chr(10)));
  IF v_new = v_def THEN
    RAISE EXCEPTION 'can_corporate_user_view_driver: user filter not found';
  END IF;
  EXECUTE v_new;
END
$mig$;