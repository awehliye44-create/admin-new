
-- 1. Settings singleton
CREATE TABLE public.ai_credit_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id = true),
  free_credits_for_new_merchants integer NOT NULL DEFAULT 20,
  credit_cost_per_image integer NOT NULL DEFAULT 1,
  ai_generation_enabled boolean NOT NULL DEFAULT true,
  credit_purchase_enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);
GRANT SELECT ON public.ai_credit_settings TO authenticated, anon;
GRANT ALL ON public.ai_credit_settings TO service_role;
ALTER TABLE public.ai_credit_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "settings readable by all" ON public.ai_credit_settings FOR SELECT USING (true);
CREATE POLICY "admin manage settings" ON public.ai_credit_settings FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));
INSERT INTO public.ai_credit_settings (id) VALUES (true);

-- 2. Packages
CREATE TABLE public.ai_credit_packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  credits integer NOT NULL CHECK (credits > 0),
  price numeric(10,2) NOT NULL CHECK (price >= 0),
  currency text NOT NULL DEFAULT 'GBP',
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.ai_credit_packages TO authenticated, anon;
GRANT ALL ON public.ai_credit_packages TO service_role;
ALTER TABLE public.ai_credit_packages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "packages readable by all" ON public.ai_credit_packages FOR SELECT USING (true);
CREATE POLICY "admin manage packages" ON public.ai_credit_packages FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));

INSERT INTO public.ai_credit_packages (name, credits, price, currency, sort_order) VALUES
  ('Starter', 10, 2.00, 'GBP', 1),
  ('Standard', 50, 8.00, 'GBP', 2),
  ('Pro', 100, 15.00, 'GBP', 3);

-- 3. Merchant flag
ALTER TABLE public.merchants ADD COLUMN IF NOT EXISTS free_ai_credits_granted boolean NOT NULL DEFAULT false;

-- 4. Credit history ledger
CREATE TABLE public.merchant_ai_credit_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES public.merchants(id) ON DELETE CASCADE,
  action_type text NOT NULL CHECK (action_type IN ('free_grant','purchase','generation_used','manual_adjustment','refund')),
  credits_changed integer NOT NULL,
  balance_after integer NOT NULL,
  admin_user_id uuid,
  stripe_payment_id text,
  package_id uuid REFERENCES public.ai_credit_packages(id) ON DELETE SET NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_macr_merchant ON public.merchant_ai_credit_history(merchant_id, created_at DESC);
GRANT SELECT, INSERT ON public.merchant_ai_credit_history TO authenticated;
GRANT ALL ON public.merchant_ai_credit_history TO service_role;
ALTER TABLE public.merchant_ai_credit_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admin read history" ON public.merchant_ai_credit_history FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(),'admin'));
CREATE POLICY "merchant read own history" ON public.merchant_ai_credit_history FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.merchants m WHERE m.id = merchant_id AND m.owner_user_id = auth.uid()));
CREATE POLICY "admin insert history" ON public.merchant_ai_credit_history FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(),'admin'));

-- 5. Approve merchant + grant free credits atomically
CREATE OR REPLACE FUNCTION public.approve_merchant_with_credits(_merchant_id uuid, _admin_notes text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _free_amount integer;
  _already_granted boolean;
  _current integer;
  _new_balance integer;
  _admin uuid := auth.uid();
BEGIN
  IF NOT public.has_role(_admin, 'admin') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT free_credits_for_new_merchants INTO _free_amount FROM public.ai_credit_settings WHERE id = true;
  IF _free_amount IS NULL THEN _free_amount := 20; END IF;

  SELECT free_ai_credits_granted INTO _already_granted FROM public.merchants WHERE id = _merchant_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'merchant_not_found'; END IF;

  UPDATE public.merchants
    SET status = 'approved',
        admin_notes = COALESCE(_admin_notes, admin_notes),
        updated_at = now()
    WHERE id = _merchant_id;

  IF NOT COALESCE(_already_granted, false) AND _free_amount > 0 THEN
    INSERT INTO public.merchant_ai_credits (merchant_id, credits_remaining, updated_at)
      VALUES (_merchant_id, _free_amount, now())
      ON CONFLICT (merchant_id) DO UPDATE
        SET credits_remaining = public.merchant_ai_credits.credits_remaining + _free_amount,
            updated_at = now()
      RETURNING credits_remaining INTO _new_balance;

    UPDATE public.merchants SET free_ai_credits_granted = true WHERE id = _merchant_id;

    INSERT INTO public.merchant_ai_credit_history
      (merchant_id, action_type, credits_changed, balance_after, admin_user_id, notes)
      VALUES (_merchant_id, 'free_grant', _free_amount, _new_balance, _admin,
              'One-time free credits on approval');
  END IF;

  RETURN jsonb_build_object('ok', true, 'granted', NOT COALESCE(_already_granted,false), 'amount', _free_amount);
END $$;

-- 6. Admin manual adjustment
CREATE OR REPLACE FUNCTION public.adjust_merchant_credits(_merchant_id uuid, _delta integer, _notes text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _balance integer;
  _admin uuid := auth.uid();
BEGIN
  IF NOT public.has_role(_admin, 'admin') THEN RAISE EXCEPTION 'forbidden'; END IF;

  INSERT INTO public.merchant_ai_credits (merchant_id, credits_remaining, updated_at)
    VALUES (_merchant_id, GREATEST(_delta, 0), now())
    ON CONFLICT (merchant_id) DO UPDATE
      SET credits_remaining = GREATEST(public.merchant_ai_credits.credits_remaining + _delta, 0),
          updated_at = now()
    RETURNING credits_remaining INTO _balance;

  INSERT INTO public.merchant_ai_credit_history
    (merchant_id, action_type, credits_changed, balance_after, admin_user_id, notes)
    VALUES (_merchant_id, 'manual_adjustment', _delta, _balance, _admin, _notes);

  RETURN jsonb_build_object('ok', true, 'balance', _balance);
END $$;

-- 7. Add unique constraint to merchant_ai_credits if missing (needed for ON CONFLICT)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='merchant_ai_credits' AND indexname LIKE '%merchant_id%'
  ) THEN
    ALTER TABLE public.merchant_ai_credits ADD CONSTRAINT merchant_ai_credits_merchant_id_key UNIQUE (merchant_id);
  END IF;
END $$;

GRANT EXECUTE ON FUNCTION public.approve_merchant_with_credits(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.adjust_merchant_credits(uuid, integer, text) TO authenticated;
