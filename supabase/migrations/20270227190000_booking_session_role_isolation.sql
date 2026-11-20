-- #57F/G — Session-scoped access role (fail closed; no shared app_metadata race)
-- Customer + Driver may share Auth user/phone with independent sessions.
-- Unbound / missing session role → role-gated trips policies deny (fail closed).
-- Ownership RPCs (SECURITY DEFINER) remain the Customer list/detail path.

CREATE TABLE IF NOT EXISTS public.onecab_auth_session_roles (
  session_id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  access_role text NOT NULL CHECK (access_role = ANY (ARRAY['customer'::text, 'driver'::text])),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS onecab_auth_session_roles_user_id_idx
  ON public.onecab_auth_session_roles (user_id);

COMMENT ON TABLE public.onecab_auth_session_roles IS
  '#57F/G Per-Auth-session Customer|Driver access role. Never user-wide app_metadata.';

ALTER TABLE public.onecab_auth_session_roles ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.onecab_auth_session_roles FROM PUBLIC;
REVOKE ALL ON TABLE public.onecab_auth_session_roles FROM anon;
REVOKE ALL ON TABLE public.onecab_auth_session_roles FROM authenticated;
GRANT ALL ON TABLE public.onecab_auth_session_roles TO service_role;

-- Resolve role from THIS JWT session only (not mutable user-wide metadata).
CREATE OR REPLACE FUNCTION public.onecab_jwt_access_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT r.access_role
  FROM public.onecab_auth_session_roles r
  WHERE r.user_id = auth.uid()
    AND r.session_id::text = nullif(
      trim(both FROM coalesce(auth.jwt() ->> 'session_id', '')),
      ''
    )
  LIMIT 1;
$$;

COMMENT ON FUNCTION public.onecab_jwt_access_role() IS
  '#57F/G Session-scoped access role from onecab_auth_session_roles. Unbound → NULL (fail closed).';

GRANT EXECUTE ON FUNCTION public.onecab_jwt_access_role() TO authenticated;
GRANT EXECUTE ON FUNCTION public.onecab_jwt_access_role() TO service_role;

-- Fail closed: no coalesce unbound fallback.
DROP POLICY IF EXISTS "Customers can view own trips" ON public.trips;
CREATE POLICY "Customers can view own trips"
  ON public.trips
  FOR SELECT
  TO authenticated
  USING (
    has_role(auth.uid(), 'admin'::app_role)
    OR (
      public.onecab_jwt_access_role() = 'customer'
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
    public.onecab_jwt_access_role() = 'driver'
    AND driver_id = current_driver_profile_id()
  );

DROP POLICY IF EXISTS "Drivers can view their assigned trips" ON public.trips;
CREATE POLICY "Drivers can view their assigned trips"
  ON public.trips
  FOR SELECT
  TO authenticated
  USING (
    public.onecab_jwt_access_role() = 'driver'
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
    public.onecab_jwt_access_role() = 'driver'
    AND driver_can_view_trip_via_offer(id)
  );

DROP POLICY IF EXISTS "Customers can cancel own trips" ON public.trips;
CREATE POLICY "Customers can cancel own trips"
  ON public.trips
  FOR UPDATE
  TO authenticated
  USING (
    public.onecab_jwt_access_role() = 'customer'
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
    public.onecab_jwt_access_role() = 'customer'
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
    public.onecab_jwt_access_role() = 'driver'
    AND driver_id = current_driver_profile_id()
  )
  WITH CHECK (
    public.onecab_jwt_access_role() = 'driver'
    AND driver_id = current_driver_profile_id()
  );

DROP POLICY IF EXISTS "Drivers can update their assigned trips" ON public.trips;
CREATE POLICY "Drivers can update their assigned trips"
  ON public.trips
  FOR UPDATE
  TO authenticated
  USING (
    public.onecab_jwt_access_role() = 'driver'
    AND driver_id = current_driver_profile_id()
  )
  WITH CHECK (
    public.onecab_jwt_access_role() = 'driver'
    AND driver_id = current_driver_profile_id()
  );

DROP POLICY IF EXISTS "Drivers can accept offered trips" ON public.trips;
CREATE POLICY "Drivers can accept offered trips"
  ON public.trips
  FOR UPDATE
  TO authenticated
  USING (
    public.onecab_jwt_access_role() = 'driver'
    AND (status = ANY (ARRAY['pending'::text, 'searching'::text, 'offered'::text]))
    AND driver_can_view_trip_via_offer(id)
  )
  WITH CHECK (
    public.onecab_jwt_access_role() = 'driver'
    AND driver_id = current_driver_profile_id()
  );
