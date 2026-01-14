-- Create document_types table for configurable document type settings
CREATE TABLE public.document_types (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    description TEXT,
    is_required BOOLEAN NOT NULL DEFAULT true,
    has_expiry BOOLEAN NOT NULL DEFAULT false,
    reminder_days_before_expiry INTEGER[] NOT NULL DEFAULT ARRAY[30, 14, 7, 3, 1],
    display_order INTEGER DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.document_types ENABLE ROW LEVEL SECURITY;

-- RLS policies for document_types
CREATE POLICY "Admins can manage document types"
    ON public.document_types FOR ALL
    USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Anyone can read active document types"
    ON public.document_types FOR SELECT
    USING (is_active = true);

-- Add columns to documents table for reminder tracking
ALTER TABLE public.documents 
ADD COLUMN IF NOT EXISTS document_type_id UUID REFERENCES public.document_types(id),
ADD COLUMN IF NOT EXISTS last_reminded_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS reminder_sent_days INTEGER[] DEFAULT ARRAY[]::integer[];

-- Create driver_inbox_messages table
CREATE TABLE public.driver_inbox_messages (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    driver_id UUID NOT NULL REFERENCES public.drivers(id) ON DELETE CASCADE,
    type TEXT NOT NULL DEFAULT 'general',
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    document_type_id UUID REFERENCES public.document_types(id),
    document_id UUID REFERENCES public.documents(id) ON DELETE SET NULL,
    expiry_date DATE,
    is_read BOOLEAN NOT NULL DEFAULT false,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.driver_inbox_messages ENABLE ROW LEVEL SECURITY;

-- RLS policies for driver_inbox_messages
CREATE POLICY "Admins can manage all inbox messages"
    ON public.driver_inbox_messages FOR ALL
    USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Drivers can read own inbox messages"
    ON public.driver_inbox_messages FOR SELECT
    USING (driver_id IN (SELECT id FROM drivers WHERE user_id = auth.uid()));

CREATE POLICY "Drivers can update own inbox messages (mark as read)"
    ON public.driver_inbox_messages FOR UPDATE
    USING (driver_id IN (SELECT id FROM drivers WHERE user_id = auth.uid()))
    WITH CHECK (driver_id IN (SELECT id FROM drivers WHERE user_id = auth.uid()));

-- Insert default UK document types
INSERT INTO public.document_types (name, slug, is_required, has_expiry, reminder_days_before_expiry, display_order)
VALUES 
    ('Private Hire Insurance Certificate', 'private_hire_insurance', true, true, ARRAY[30, 14, 7, 3, 1], 1),
    ('MOT Test Certificate', 'mot_certificate', true, true, ARRAY[30, 14, 7, 3, 1], 2),
    ('PHV (Private Hire Vehicle License)', 'phv_license', true, true, ARRAY[30, 14, 7, 3, 1], 3),
    ('DVLA Electronic Counterpart Check Code', 'dvla_check_code', true, false, ARRAY[]::integer[], 4),
    ('PHD Badge (Private Hire Driver Badge)', 'phd_badge', true, true, ARRAY[30, 14, 7, 3, 1], 5),
    ('PHL (Private Hire Driver License)', 'phl_license', true, true, ARRAY[30, 14, 7, 3, 1], 6),
    ('DVLA Driving License (Pink Card – Front)', 'dvla_driving_license', true, true, ARRAY[30, 14, 7, 3, 1], 7),
    ('Profile Photo', 'profile_photo', true, false, ARRAY[]::integer[], 8),
    ('V5 Logbook (Full)', 'v5_logbook', true, false, ARRAY[]::integer[], 9),
    ('UTR (Unique Taxpayer Reference)', 'utr_number', true, false, ARRAY[]::integer[], 10),
    ('National Insurance Number', 'national_insurance', true, false, ARRAY[]::integer[], 11);

-- Update documents table to link existing documents to document_types by slug
UPDATE public.documents d
SET document_type_id = dt.id
FROM public.document_types dt
WHERE d.document_type = dt.slug;

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_documents_expiry_date ON public.documents(expiry_date);
CREATE INDEX IF NOT EXISTS idx_documents_document_type_id ON public.documents(document_type_id);
CREATE INDEX IF NOT EXISTS idx_driver_inbox_messages_driver_id ON public.driver_inbox_messages(driver_id);
CREATE INDEX IF NOT EXISTS idx_driver_inbox_messages_is_read ON public.driver_inbox_messages(is_read);

-- Trigger for updated_at on document_types
CREATE TRIGGER update_document_types_updated_at
BEFORE UPDATE ON public.document_types
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Trigger for updated_at on driver_inbox_messages
CREATE TRIGGER update_driver_inbox_messages_updated_at
BEFORE UPDATE ON public.driver_inbox_messages
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();