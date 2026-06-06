
-- Add regeneration cost setting + AI suspension flag
ALTER TABLE public.ai_credit_settings
  ADD COLUMN IF NOT EXISTS credit_cost_per_regeneration INTEGER NOT NULL DEFAULT 1;

ALTER TABLE public.merchants
  ADD COLUMN IF NOT EXISTS ai_access_suspended BOOLEAN NOT NULL DEFAULT false;

-- Seed Enterprise package if not present
INSERT INTO public.ai_credit_packages (name, credits, price, currency, active, sort_order)
SELECT 'Enterprise', 500, 60.00, 'GBP', true,
       COALESCE((SELECT MAX(sort_order) FROM public.ai_credit_packages), 0) + 1
WHERE NOT EXISTS (SELECT 1 FROM public.ai_credit_packages WHERE name = 'Enterprise');
