-- Create corporate_accounts table for proper data storage
CREATE TABLE public.corporate_accounts (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    company_name TEXT NOT NULL,
    contact_name TEXT NOT NULL,
    contact_email TEXT NOT NULL,
    contact_phone TEXT,
    billing_email TEXT,
    address TEXT,
    city TEXT,
    country TEXT,
    tax_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    payment_terms TEXT DEFAULT 'net30',
    credit_limit NUMERIC DEFAULT 10000,
    current_balance NUMERIC DEFAULT 0,
    discount_percentage NUMERIC DEFAULT 0,
    notes TEXT,
    employee_count INTEGER DEFAULT 0,
    monthly_budget NUMERIC DEFAULT 0,
    region_id UUID REFERENCES public.regions(id),
    service_area_id UUID REFERENCES public.service_areas(id),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.corporate_accounts ENABLE ROW LEVEL SECURITY;

-- RLS policies
CREATE POLICY "Admins can manage corporate accounts"
    ON public.corporate_accounts FOR ALL
    USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Public can read active corporate accounts"
    ON public.corporate_accounts FOR SELECT
    USING (status = 'active');

-- Create corporate_invoices table
CREATE TABLE public.corporate_invoices (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    invoice_number TEXT NOT NULL UNIQUE,
    corporate_account_id UUID NOT NULL REFERENCES public.corporate_accounts(id) ON DELETE CASCADE,
    amount NUMERIC NOT NULL DEFAULT 0,
    tax_amount NUMERIC DEFAULT 0,
    total_amount NUMERIC NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    due_date DATE NOT NULL,
    paid_at TIMESTAMP WITH TIME ZONE,
    billing_period_start DATE,
    billing_period_end DATE,
    trip_count INTEGER DEFAULT 0,
    notes TEXT,
    region_id UUID REFERENCES public.regions(id),
    service_area_id UUID REFERENCES public.service_areas(id),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.corporate_invoices ENABLE ROW LEVEL SECURITY;

-- RLS policies
CREATE POLICY "Admins can manage corporate invoices"
    ON public.corporate_invoices FOR ALL
    USING (has_role(auth.uid(), 'admin'::app_role));

-- Create corporate_account_requests table
CREATE TABLE public.corporate_account_requests (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    company_name TEXT NOT NULL,
    contact_name TEXT NOT NULL,
    contact_email TEXT NOT NULL,
    contact_phone TEXT,
    address TEXT,
    city TEXT,
    country TEXT,
    tax_id TEXT,
    employee_count INTEGER DEFAULT 0,
    estimated_monthly_trips INTEGER DEFAULT 0,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    reviewed_at TIMESTAMP WITH TIME ZONE,
    reviewed_by UUID,
    rejection_reason TEXT,
    region_id UUID REFERENCES public.regions(id),
    service_area_id UUID REFERENCES public.service_areas(id),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.corporate_account_requests ENABLE ROW LEVEL SECURITY;

-- RLS policies
CREATE POLICY "Admins can manage account requests"
    ON public.corporate_account_requests FOR ALL
    USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Anyone can submit account requests"
    ON public.corporate_account_requests FOR INSERT
    WITH CHECK (true);

-- Create indexes
CREATE INDEX idx_corporate_accounts_region ON public.corporate_accounts(region_id);
CREATE INDEX idx_corporate_accounts_service_area ON public.corporate_accounts(service_area_id);
CREATE INDEX idx_corporate_accounts_status ON public.corporate_accounts(status);
CREATE INDEX idx_corporate_invoices_account ON public.corporate_invoices(corporate_account_id);
CREATE INDEX idx_corporate_invoices_status ON public.corporate_invoices(status);
CREATE INDEX idx_corporate_account_requests_status ON public.corporate_account_requests(status);

-- Triggers for updated_at
CREATE TRIGGER update_corporate_accounts_updated_at
BEFORE UPDATE ON public.corporate_accounts
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_corporate_invoices_updated_at
BEFORE UPDATE ON public.corporate_invoices
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_corporate_account_requests_updated_at
BEFORE UPDATE ON public.corporate_account_requests
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();