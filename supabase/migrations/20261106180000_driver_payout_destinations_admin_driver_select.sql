-- Admin + driver SELECT on payout destinations so Admin DriverPayoutPanel can show
-- saved accounts (Verify / Sync buttons). Service role continues to bypass RLS.

ALTER TABLE public.driver_payout_destinations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.driver_payout_destination_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS driver_payout_destinations_admin_select ON public.driver_payout_destinations;
CREATE POLICY driver_payout_destinations_admin_select
  ON public.driver_payout_destinations
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role));

DROP POLICY IF EXISTS driver_payout_destinations_driver_select ON public.driver_payout_destinations;
CREATE POLICY driver_payout_destinations_driver_select
  ON public.driver_payout_destinations
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.drivers d
      WHERE d.id = driver_payout_destinations.driver_id
        AND d.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS driver_payout_destination_audit_admin_select ON public.driver_payout_destination_audit;
CREATE POLICY driver_payout_destination_audit_admin_select
  ON public.driver_payout_destination_audit
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role));

DROP POLICY IF EXISTS driver_payout_destination_audit_driver_select ON public.driver_payout_destination_audit;
CREATE POLICY driver_payout_destination_audit_driver_select
  ON public.driver_payout_destination_audit
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.drivers d
      WHERE d.id = driver_payout_destination_audit.driver_id
        AND d.user_id = auth.uid()
    )
  );

GRANT SELECT ON public.driver_payout_destinations TO authenticated;
GRANT SELECT ON public.driver_payout_destination_audit TO authenticated;
