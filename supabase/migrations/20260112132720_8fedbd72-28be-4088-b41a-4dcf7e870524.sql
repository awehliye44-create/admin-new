-- Create documents table for driver/vehicle document management
CREATE TABLE public.documents (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  driver_id UUID NOT NULL REFERENCES public.drivers(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL,
  document_name TEXT NOT NULL,
  file_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  expiry_date DATE,
  notes TEXT,
  rejection_reason TEXT,
  reviewed_by UUID,
  reviewed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create driver_categories table
CREATE TABLE public.driver_categories (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  icon TEXT DEFAULT 'car',
  color TEXT DEFAULT '#3B82F6',
  requirements TEXT[] DEFAULT ARRAY[]::TEXT[],
  min_rating NUMERIC DEFAULT 0,
  min_trips INTEGER DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  display_order INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create promo_codes table
CREATE TABLE public.promo_codes (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  description TEXT,
  discount_type TEXT NOT NULL DEFAULT 'percentage',
  discount_value NUMERIC NOT NULL DEFAULT 0,
  min_fare NUMERIC DEFAULT 0,
  max_discount NUMERIC,
  usage_limit INTEGER,
  usage_count INTEGER NOT NULL DEFAULT 0,
  per_user_limit INTEGER DEFAULT 1,
  valid_from TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  valid_until TIMESTAMP WITH TIME ZONE,
  applicable_vehicle_types UUID[],
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS on all tables
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.driver_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.promo_codes ENABLE ROW LEVEL SECURITY;

-- Documents policies
CREATE POLICY "Admins can manage all documents" 
ON public.documents FOR ALL 
USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Drivers can view own documents" 
ON public.documents FOR SELECT 
USING (driver_id IN (SELECT id FROM drivers WHERE user_id = auth.uid()));

CREATE POLICY "Drivers can upload own documents" 
ON public.documents FOR INSERT 
WITH CHECK (driver_id IN (SELECT id FROM drivers WHERE user_id = auth.uid()));

-- Driver categories policies
CREATE POLICY "Admins can manage driver categories" 
ON public.driver_categories FOR ALL 
USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Anyone can read active driver categories" 
ON public.driver_categories FOR SELECT 
USING (is_active = true);

-- Promo codes policies
CREATE POLICY "Admins can manage promo codes" 
ON public.promo_codes FOR ALL 
USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Anyone can read active promo codes" 
ON public.promo_codes FOR SELECT 
USING (is_active = true AND (valid_until IS NULL OR valid_until > now()));

-- Add triggers for updated_at
CREATE TRIGGER update_documents_updated_at
BEFORE UPDATE ON public.documents
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_driver_categories_updated_at
BEFORE UPDATE ON public.driver_categories
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_promo_codes_updated_at
BEFORE UPDATE ON public.promo_codes
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Insert default driver categories
INSERT INTO public.driver_categories (name, description, icon, color, requirements, display_order) VALUES
('Standard', 'Regular drivers meeting basic requirements', 'car', '#6B7280', ARRAY['Valid license', 'Background check'], 1),
('Premium', 'Experienced drivers with high ratings', 'star', '#F59E0B', ARRAY['4.8+ rating', '100+ trips', 'Premium vehicle'], 2),
('Executive', 'Top-tier professional drivers', 'crown', '#8B5CF6', ARRAY['4.9+ rating', '500+ trips', 'Luxury vehicle', 'Professional attire'], 3);