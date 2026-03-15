-- Create complaints table
CREATE TABLE public.complaints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  complaint_number text NOT NULL,
  reporter_type text NOT NULL DEFAULT 'rider',
  reporter_id uuid,
  reporter_name text NOT NULL,
  reporter_email text,
  reported_user_type text NOT NULL DEFAULT 'driver',
  reported_user_id uuid,
  reported_user_name text NOT NULL,
  trip_id uuid REFERENCES public.trips(id),
  category text NOT NULL DEFAULT 'General',
  priority text NOT NULL DEFAULT 'medium',
  status text NOT NULL DEFAULT 'new',
  subject text NOT NULL,
  description text NOT NULL DEFAULT '',
  assigned_to text,
  resolution text,
  resolved_at timestamptz,
  resolved_by uuid,
  service_area_id uuid REFERENCES public.service_areas(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Add unique constraint on complaint_number
ALTER TABLE public.complaints ADD CONSTRAINT complaints_number_unique UNIQUE (complaint_number);

-- Enable RLS
ALTER TABLE public.complaints ENABLE ROW LEVEL SECURITY;

-- Admin-only policies
CREATE POLICY "Admins can read complaints" ON public.complaints
  FOR SELECT TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins can insert complaints" ON public.complaints
  FOR INSERT TO authenticated
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins can update complaints" ON public.complaints
  FOR UPDATE TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins can delete complaints" ON public.complaints
  FOR DELETE TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role));

-- Auto-update updated_at
CREATE TRIGGER update_complaints_updated_at
  BEFORE UPDATE ON public.complaints
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Sequence for complaint numbers
CREATE TABLE IF NOT EXISTS public.complaint_sequences (
  service_area_id uuid PRIMARY KEY REFERENCES public.service_areas(id),
  current_value integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.complaint_sequences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins manage complaint sequences" ON public.complaint_sequences
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role));

-- Function to generate complaint number
CREATE OR REPLACE FUNCTION public.generate_complaint_number()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $$
DECLARE
  v_seq integer;
BEGIN
  -- Simple global sequence via admin_settings or just use a counter
  SELECT COALESCE(MAX(
    CASE WHEN complaint_number ~ '^CMP-[0-9]+$' 
    THEN CAST(SUBSTRING(complaint_number FROM 5) AS integer) 
    ELSE 0 END
  ), 0) + 1 INTO v_seq
  FROM public.complaints;
  
  NEW.complaint_number := 'CMP-' || LPAD(v_seq::text, 5, '0');
  RETURN NEW;
END;
$$;

CREATE TRIGGER tr_generate_complaint_number
  BEFORE INSERT ON public.complaints
  FOR EACH ROW
  WHEN (NEW.complaint_number IS NULL OR NEW.complaint_number = '')
  EXECUTE FUNCTION generate_complaint_number();