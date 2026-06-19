
CREATE TABLE public.onecab_expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category TEXT NOT NULL CHECK (category IN ('technology','marketing','operations','staff','other')),
  subcategory TEXT NOT NULL,
  description TEXT,
  amount_pence BIGINT NOT NULL CHECK (amount_pence >= 0),
  currency_code TEXT NOT NULL DEFAULT 'GBP',
  region_id UUID REFERENCES public.regions(id) ON DELETE SET NULL,
  service_area_id UUID REFERENCES public.service_areas(id) ON DELETE SET NULL,
  expense_date DATE NOT NULL DEFAULT CURRENT_DATE,
  notes TEXT,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.onecab_expenses TO authenticated;
GRANT ALL ON public.onecab_expenses TO service_role;

ALTER TABLE public.onecab_expenses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins manage onecab expenses"
ON public.onecab_expenses
FOR ALL
TO authenticated
USING (public.has_role(auth.uid(), 'admin'))
WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE INDEX idx_onecab_expenses_date ON public.onecab_expenses(expense_date DESC);
CREATE INDEX idx_onecab_expenses_region ON public.onecab_expenses(region_id);
CREATE INDEX idx_onecab_expenses_category ON public.onecab_expenses(category);

CREATE TRIGGER update_onecab_expenses_updated_at
BEFORE UPDATE ON public.onecab_expenses
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
