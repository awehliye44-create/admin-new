
-- Enable RLS on stripe_connect_payouts
ALTER TABLE public.stripe_connect_payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_connect_payouts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins manage stripe payouts" ON public.stripe_connect_payouts;
CREATE POLICY "Admins manage stripe payouts"
ON public.stripe_connect_payouts
FOR ALL
TO authenticated
USING (has_role(auth.uid(), 'admin'::app_role))
WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

DROP POLICY IF EXISTS "Drivers read own stripe payouts" ON public.stripe_connect_payouts;
CREATE POLICY "Drivers read own stripe payouts"
ON public.stripe_connect_payouts
FOR SELECT
TO authenticated
USING (
  driver_id IN (SELECT id FROM public.drivers WHERE user_id = auth.uid())
);

-- Remove public PII exposure on merchants (marketplace deprecated)
DROP POLICY IF EXISTS "Public can read approved merchants (rows only)" ON public.merchants;
DROP POLICY IF EXISTS "Public can read approved merchants" ON public.merchants;
