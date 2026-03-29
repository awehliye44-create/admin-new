
-- Invoice Templates: admin-configurable templates for driver earnings statements
CREATE TABLE public.invoice_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL DEFAULT 'Default Template',
  is_default BOOLEAN NOT NULL DEFAULT false,
  logo_url TEXT,
  company_name TEXT NOT NULL DEFAULT 'ONECAB',
  company_address TEXT,
  company_email TEXT,
  company_phone TEXT,
  company_registration TEXT,
  invoice_title TEXT NOT NULL DEFAULT 'Driver Earnings Statement',
  payment_terms TEXT DEFAULT 'Payment processed automatically',
  due_date_label TEXT DEFAULT 'Statement Period',
  notes_footer TEXT,
  table_columns JSONB NOT NULL DEFAULT '["description","quantity","unit_price","amount"]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID REFERENCES auth.users(id)
);

ALTER TABLE public.invoice_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view templates"
  ON public.invoice_templates FOR SELECT TO authenticated USING (true);

CREATE POLICY "Admins can manage templates"
  ON public.invoice_templates FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Statement Runs: batch generation runs
CREATE TABLE public.statement_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  region_id UUID REFERENCES public.regions(id),
  service_area_id UUID REFERENCES public.service_areas(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','generating','completed','sending','sent','failed')),
  total_invoices INTEGER NOT NULL DEFAULT 0,
  total_amount_pence BIGINT NOT NULL DEFAULT 0,
  currency_code TEXT NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  created_by UUID REFERENCES auth.users(id)
);

ALTER TABLE public.statement_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view statement runs"
  ON public.statement_runs FOR SELECT TO authenticated USING (true);

CREATE POLICY "Admins can manage statement runs"
  ON public.statement_runs FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Invoices: individual driver earnings statements
CREATE TABLE public.invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number TEXT NOT NULL UNIQUE,
  statement_run_id UUID REFERENCES public.statement_runs(id) ON DELETE SET NULL,
  driver_id UUID REFERENCES public.drivers(id) NOT NULL,
  template_id UUID REFERENCES public.invoice_templates(id),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  region_id UUID REFERENCES public.regions(id),
  service_area_id UUID REFERENCES public.service_areas(id),
  currency_code TEXT NOT NULL,
  -- Financial totals from driver_ledger (backend source of truth)
  gross_earnings_pence BIGINT NOT NULL DEFAULT 0,
  commission_pence BIGINT NOT NULL DEFAULT 0,
  bonuses_pence BIGINT NOT NULL DEFAULT 0,
  penalties_pence BIGINT NOT NULL DEFAULT 0,
  adjustments_pence BIGINT NOT NULL DEFAULT 0,
  cash_collected_pence BIGINT NOT NULL DEFAULT 0,
  net_earnings_pence BIGINT NOT NULL DEFAULT 0,
  -- Trip counts
  completed_trips INTEGER NOT NULL DEFAULT 0,
  no_show_trips INTEGER NOT NULL DEFAULT 0,
  late_cancel_trips INTEGER NOT NULL DEFAULT 0,
  -- Status
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','finalized','sent','viewed','cancelled')),
  pdf_storage_path TEXT,
  -- Audit
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalized_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  sent_by UUID REFERENCES auth.users(id),
  viewed_at TIMESTAMPTZ,
  template_version INTEGER DEFAULT 1
);

ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view invoices"
  ON public.invoices FOR SELECT TO authenticated USING (true);

CREATE POLICY "Admins can manage invoices"
  ON public.invoices FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Invoice Items: line items on each invoice
CREATE TABLE public.invoice_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID REFERENCES public.invoices(id) ON DELETE CASCADE NOT NULL,
  item_type TEXT NOT NULL CHECK (item_type IN ('trip_earnings','commission','bonus','penalty','adjustment','cash_collected','no_show','late_cancel','service_fee','tip','other')),
  description TEXT NOT NULL,
  quantity INTEGER DEFAULT 1,
  unit_price_pence BIGINT NOT NULL DEFAULT 0,
  amount_pence BIGINT NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  metadata JSONB
);

ALTER TABLE public.invoice_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view invoice items"
  ON public.invoice_items FOR SELECT TO authenticated USING (true);

CREATE POLICY "Admins can manage invoice items"
  ON public.invoice_items FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Invoice Delivery Logs: email delivery tracking
CREATE TABLE public.invoice_delivery_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID REFERENCES public.invoices(id) ON DELETE CASCADE NOT NULL,
  sent_to_email TEXT NOT NULL,
  sent_by UUID REFERENCES auth.users(id),
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivery_status TEXT NOT NULL DEFAULT 'sent' CHECK (delivery_status IN ('sent','delivered','failed','bounced')),
  error_message TEXT
);

ALTER TABLE public.invoice_delivery_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view delivery logs"
  ON public.invoice_delivery_logs FOR SELECT TO authenticated USING (true);

CREATE POLICY "Admins can manage delivery logs"
  ON public.invoice_delivery_logs FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Sequence for invoice numbers
CREATE SEQUENCE public.invoice_number_seq START 1001;

-- Function to generate invoice numbers
CREATE OR REPLACE FUNCTION public.generate_invoice_number()
RETURNS TEXT
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN 'INV-' || to_char(now(), 'YYYYMM') || '-' || lpad(nextval('public.invoice_number_seq')::text, 5, '0');
END;
$$;

-- Insert default template
INSERT INTO public.invoice_templates (name, is_default, company_name, invoice_title, payment_terms, notes_footer)
VALUES ('Default Earnings Statement', true, 'ONECAB', 'Driver Earnings Statement', 'Payment processed automatically via platform wallet', 'This is a system-generated earnings statement. For queries, contact support.');
