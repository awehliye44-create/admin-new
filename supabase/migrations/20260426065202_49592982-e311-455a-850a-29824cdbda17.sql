CREATE TABLE public.admin_payment_audit (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  trip_id UUID NOT NULL,
  admin_user_id UUID NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('capture','refund','edit_fare')),
  reason TEXT NOT NULL,
  amount_pence_before INTEGER,
  amount_pence_after INTEGER,
  delta_pence INTEGER,
  stripe_payment_intent_id TEXT,
  stripe_refund_id TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_admin_payment_audit_trip_id ON public.admin_payment_audit(trip_id);
CREATE INDEX idx_admin_payment_audit_created_at ON public.admin_payment_audit(created_at DESC);

ALTER TABLE public.admin_payment_audit ENABLE ROW LEVEL SECURITY;

-- Only admins can read. No insert/update/delete policies => writes only via service role.
CREATE POLICY "Admins can view payment audit"
ON public.admin_payment_audit
FOR SELECT
TO authenticated
USING (public.has_role(auth.uid(), 'admin'));