-- #111A — Drivers must SELECT terminal-fee trips after driver_id is cleared.
-- chargeable_terminal_outcome_driver_preserve copies the entitled driver to
-- previous_driver_id and nulls driver_id / confirmed_driver_id. Wallet Activity
-- then could not resolve trip status/financial_outcome for No-show presentation
-- (MK-261126-001). Extend SELECT only — never UPDATE via previous_driver_id.

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
      OR previous_driver_id = current_driver_profile_id()
    )
  );

COMMENT ON POLICY "Drivers can view their assigned trips" ON public.trips IS
  '#111A: SELECT includes previous_driver_id so Wallet/Earnings can resolve terminal no-show trip presentation after assignment columns are cleared.';
