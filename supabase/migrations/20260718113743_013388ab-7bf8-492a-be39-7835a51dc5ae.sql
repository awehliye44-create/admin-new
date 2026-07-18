
ALTER FUNCTION public.is_commission_wallet_workflow_enabled(uuid) SET search_path = public;
ALTER FUNCTION public.prevent_commission_wallet_ledger_mutation() SET search_path = public;
ALTER FUNCTION public.required_commission_reserve_minor(integer, integer) SET search_path = public;
ALTER FUNCTION public.trip_commission_reserve_fare_minor(public.trips) SET search_path = public;

DROP POLICY IF EXISTS commission_wallet_rollout_admin_read ON public.commission_wallet_rollout;
CREATE POLICY commission_wallet_rollout_admin_read
ON public.commission_wallet_rollout
FOR SELECT
TO authenticated
USING (public.has_role(auth.uid(), 'admin'::public.app_role));
