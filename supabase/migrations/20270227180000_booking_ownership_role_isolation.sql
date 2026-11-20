-- #57 — Booking ownership + dual-role access isolation
-- Customer trip reads via ownership-scoped SECURITY DEFINER RPCs.
-- trips SELECT policies require JWT app_metadata.onecab_access = customer|driver
-- so a dual-role Auth user cannot OR driver assignment into Customer lists.

CREATE OR REPLACE FUNCTION public.onecab_jwt_access_role()
RETURNS text
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT nullif(
    lower(trim(both FROM coalesce(auth.jwt() -> 'app_metadata' ->> 'onecab_access', ''))),
    ''
  );
$$;

COMMENT ON FUNCTION public.onecab_jwt_access_role() IS
  '#57 JWT app_metadata.onecab_access (customer|driver). Set only via service-role bind Edge.';

CREATE OR REPLACE FUNCTION public.customer_list_my_trips(p_limit integer DEFAULT 100)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_customer_id uuid;
  v_limit integer := GREATEST(1, LEAST(COALESCE(p_limit, 100), 500));
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  SELECT c.id INTO v_customer_id
  FROM public.customers c
  WHERE c.user_id = auth.uid()
  LIMIT 1;

  IF v_customer_id IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;

  RETURN COALESCE(
    (
      SELECT jsonb_agg(to_jsonb(t) ORDER BY t.created_at DESC)
      FROM (
        SELECT
          tr.id,
          tr.trip_code,
          tr.status,
          tr.pickup_address,
          tr.dropoff_address,
          tr.pickup_latitude,
          tr.pickup_longitude,
          tr.dropoff_latitude,
          tr.dropoff_longitude,
          tr.stops,
          tr.scheduled_at,
          tr.is_scheduled,
          tr.dispatch_mode,
          tr.scheduled_status,
          tr.scheduled_broadcast_at,
          tr.scheduled_convert_at,
          tr.created_at,
          tr.completed_at,
          tr.cancelled_at,
          tr.cancelled_by,
          tr.cancel_reason,
          tr.financial_outcome,
          tr.arrival_cancellation_applied,
          tr.cancellation_fee_pence,
          tr.no_show_charge_pence,
          tr.fare,
          tr.final_fare_pence,
          tr.final_customer_fare_pence,
          tr.capture_amount_pence,
          tr.outstanding_balance_pence,
          tr.payment_status,
          tr.payment_hold_status,
          tr.tip_pence,
          tr.tip_amount_pence,
          tr.tip_window_expires_at,
          tr.tip_window_closed_at,
          tr.refund_amount_pence,
          tr.estimated_fare,
          tr.estimated_total_pence,
          tr.payment_method,
          tr.vehicle_type_id,
          tr.confirmed_driver_id,
          tr.started_at,
          tr.arrived_at,
          tr.invoice_email_sent_at,
          tr.invoice_email_status,
          tr.special_instructions
        FROM public.trips tr
        WHERE tr.passenger_id = v_customer_id
        ORDER BY tr.created_at DESC
        LIMIT v_limit
      ) t
    ),
    '[]'::jsonb
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.customer_get_my_trip(p_trip_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_customer_id uuid;
  v_row jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  IF p_trip_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT c.id INTO v_customer_id
  FROM public.customers c
  WHERE c.user_id = auth.uid()
  LIMIT 1;

  IF v_customer_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT to_jsonb(t) INTO v_row
  FROM (
    SELECT
      tr.id,
      tr.trip_code,
      tr.status,
      tr.pickup_address,
      tr.dropoff_address,
      tr.pickup_latitude,
      tr.pickup_longitude,
      tr.dropoff_latitude,
      tr.dropoff_longitude,
      tr.stops,
      tr.scheduled_at,
      tr.is_scheduled,
      tr.dispatch_mode,
      tr.scheduled_status,
      tr.scheduled_broadcast_at,
      tr.scheduled_convert_at,
      tr.created_at,
      tr.completed_at,
      tr.cancelled_at,
      tr.cancelled_by,
      tr.cancel_reason,
      tr.financial_outcome,
      tr.arrival_cancellation_applied,
      tr.cancellation_fee_pence,
      tr.no_show_charge_pence,
      tr.fare,
      tr.final_fare_pence,
      tr.final_customer_fare_pence,
      tr.capture_amount_pence,
      tr.outstanding_balance_pence,
      tr.payment_status,
      tr.payment_hold_status,
      tr.tip_pence,
      tr.tip_amount_pence,
      tr.tip_window_expires_at,
      tr.tip_window_closed_at,
      tr.refund_amount_pence,
      tr.estimated_fare,
      tr.estimated_total_pence,
      tr.payment_method,
      tr.vehicle_type_id,
      tr.confirmed_driver_id,
      tr.started_at,
      tr.arrived_at,
      tr.invoice_email_sent_at,
      tr.invoice_email_status,
      tr.special_instructions,
      tr.driver_id,
      tr.passenger_id
    FROM public.trips tr
    WHERE tr.id = p_trip_id
      AND tr.passenger_id = v_customer_id
    LIMIT 1
  ) t;

  RETURN v_row;
END;
$$;

COMMENT ON FUNCTION public.customer_list_my_trips(integer) IS
  '#57 Customer trip list — passenger_id ownership only (SECURITY DEFINER).';
COMMENT ON FUNCTION public.customer_get_my_trip(uuid) IS
  '#57 Customer trip detail — passenger_id ownership only (SECURITY DEFINER).';

GRANT EXECUTE ON FUNCTION public.customer_list_my_trips(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.customer_get_my_trip(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.onecab_jwt_access_role() TO authenticated;

-- Access-role helpers: unbound JWT (legacy / pre-bind) keeps prior OR behaviour;
-- once app_metadata.onecab_access is set, policies are exclusive per app bind.
-- Customer list/detail must use ownership RPCs regardless (defense in depth).

DROP POLICY IF EXISTS "Customers can view own trips" ON public.trips;
CREATE POLICY "Customers can view own trips"
  ON public.trips
  FOR SELECT
  TO authenticated
  USING (
    has_role(auth.uid(), 'admin'::app_role)
    OR (
      coalesce(public.onecab_jwt_access_role(), 'customer') = 'customer'
      AND passenger_id IN (
        SELECT customers.id FROM public.customers WHERE customers.user_id = auth.uid()
      )
    )
  );

DROP POLICY IF EXISTS "Drivers can view assigned trips" ON public.trips;
CREATE POLICY "Drivers can view assigned trips"
  ON public.trips
  FOR SELECT
  TO authenticated
  USING (
    coalesce(public.onecab_jwt_access_role(), 'driver') = 'driver'
    AND driver_id = current_driver_profile_id()
  );

DROP POLICY IF EXISTS "Drivers can view their assigned trips" ON public.trips;
CREATE POLICY "Drivers can view their assigned trips"
  ON public.trips
  FOR SELECT
  TO authenticated
  USING (
    coalesce(public.onecab_jwt_access_role(), 'driver') = 'driver'
    AND (
      driver_id = current_driver_profile_id()
      OR confirmed_driver_id = current_driver_profile_id()
    )
  );

DROP POLICY IF EXISTS "Drivers can view offered trips" ON public.trips;
CREATE POLICY "Drivers can view offered trips"
  ON public.trips
  FOR SELECT
  TO authenticated
  USING (
    coalesce(public.onecab_jwt_access_role(), 'driver') = 'driver'
    AND driver_can_view_trip_via_offer(id)
  );

-- Customer cancel UPDATE — passenger ownership only (no driver fall-through).
DROP POLICY IF EXISTS "Customers can cancel own trips" ON public.trips;
CREATE POLICY "Customers can cancel own trips"
  ON public.trips
  FOR UPDATE
  TO authenticated
  USING (
    coalesce(public.onecab_jwt_access_role(), 'customer') = 'customer'
    AND passenger_id IN (
      SELECT customers.id FROM public.customers WHERE customers.user_id = auth.uid()
    )
    AND status = ANY (
      ARRAY[
        'pending'::text,
        'searching'::text,
        'offered'::text,
        'accepted'::text,
        'driver_assigned'::text,
        'scheduled'::text
      ]
    )
  )
  WITH CHECK (
    coalesce(public.onecab_jwt_access_role(), 'customer') = 'customer'
    AND passenger_id IN (
      SELECT customers.id FROM public.customers WHERE customers.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Drivers can update assigned trips" ON public.trips;
CREATE POLICY "Drivers can update assigned trips"
  ON public.trips
  FOR UPDATE
  TO authenticated
  USING (
    coalesce(public.onecab_jwt_access_role(), 'driver') = 'driver'
    AND driver_id = current_driver_profile_id()
  )
  WITH CHECK (
    coalesce(public.onecab_jwt_access_role(), 'driver') = 'driver'
    AND driver_id = current_driver_profile_id()
  );

DROP POLICY IF EXISTS "Drivers can update their assigned trips" ON public.trips;
CREATE POLICY "Drivers can update their assigned trips"
  ON public.trips
  FOR UPDATE
  TO authenticated
  USING (
    coalesce(public.onecab_jwt_access_role(), 'driver') = 'driver'
    AND driver_id = current_driver_profile_id()
  )
  WITH CHECK (
    coalesce(public.onecab_jwt_access_role(), 'driver') = 'driver'
    AND driver_id = current_driver_profile_id()
  );

DROP POLICY IF EXISTS "Drivers can accept offered trips" ON public.trips;
CREATE POLICY "Drivers can accept offered trips"
  ON public.trips
  FOR UPDATE
  TO authenticated
  USING (
    coalesce(public.onecab_jwt_access_role(), 'driver') = 'driver'
    AND (status = ANY (ARRAY['pending'::text, 'searching'::text, 'offered'::text]))
    AND driver_can_view_trip_via_offer(id)
  )
  WITH CHECK (
    coalesce(public.onecab_jwt_access_role(), 'driver') = 'driver'
    AND driver_id = current_driver_profile_id()
  );
