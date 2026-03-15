
-- Account suspensions table
CREATE TABLE public.account_suspensions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_type text NOT NULL CHECK (user_type IN ('driver', 'rider')),
  user_id uuid NOT NULL,
  user_name text NOT NULL DEFAULT '',
  user_email text NOT NULL DEFAULT '',
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'lifted', 'expired')),
  suspended_at timestamptz NOT NULL DEFAULT now(),
  suspended_by uuid REFERENCES auth.users(id),
  suspended_by_name text NOT NULL DEFAULT 'System',
  duration_days integer,
  expires_at timestamptz,
  lifted_at timestamptz,
  lifted_by uuid REFERENCES auth.users(id),
  lifted_by_name text,
  notes text DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_account_suspensions_status ON public.account_suspensions(status);
CREATE INDEX idx_account_suspensions_user ON public.account_suspensions(user_id, user_type);

CREATE TRIGGER update_account_suspensions_updated_at
  BEFORE UPDATE ON public.account_suspensions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE public.account_suspensions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can manage suspensions"
  ON public.account_suspensions
  FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));

CREATE OR REPLACE FUNCTION public.is_user_suspended(p_user_id uuid, p_user_type text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.account_suspensions
    WHERE user_id = p_user_id
      AND user_type = p_user_type
      AND status = 'active'
      AND (expires_at IS NULL OR expires_at > now())
  )
$$;
