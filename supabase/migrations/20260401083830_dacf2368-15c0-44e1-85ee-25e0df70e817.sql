
-- ============= ADD MISSING COLUMNS TO CASES =============

ALTER TABLE public.lost_property_cases
  ADD COLUMN IF NOT EXISTS found_item_photos text[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS customer_confirmed boolean,
  ADD COLUMN IF NOT EXISTS chat_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS chat_opened_at timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS chat_expires_at timestamptz NOT NULL DEFAULT (now() + interval '10 days'),
  ADD COLUMN IF NOT EXISTS chat_locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS chat_lock_reason text,
  ADD COLUMN IF NOT EXISTS admin_joined_at timestamptz,
  ADD COLUMN IF NOT EXISTS photos_hidden_at timestamptz,
  ADD COLUMN IF NOT EXISTS photos_delete_at timestamptz,
  ADD COLUMN IF NOT EXISTS admin_viewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS admin_last_read_message_at timestamptz;

-- Make service_area_id NOT NULL (should always be set from trip)
ALTER TABLE public.lost_property_cases ALTER COLUMN service_area_id SET NOT NULL;
ALTER TABLE public.lost_property_cases ALTER COLUMN driver_id SET NOT NULL;

-- Update status constraint
ALTER TABLE public.lost_property_cases DROP CONSTRAINT IF EXISTS lost_property_cases_status_check;
ALTER TABLE public.lost_property_cases ADD CONSTRAINT lost_property_cases_status_check CHECK (status IN (
  'NEW','SENT_TO_DRIVER','DRIVER_CONFIRMED_FOUND','DRIVER_NOT_FOUND',
  'AWAITING_CUSTOMER_CONFIRMATION','AWAITING_RETURN_METHOD','AWAITING_COLLECTION',
  'RETURN_RIDE_REQUESTED','RETURN_RIDE_BOOKED','ESCALATED','CLOSED',
  'sent_to_driver','driver_confirmed','driver_not_found','awaiting_collection',
  'return_ride_booked','closed'
));

-- Add chat_lock_reason constraint
ALTER TABLE public.lost_property_cases ADD CONSTRAINT valid_chat_lock_reason CHECK (
  chat_lock_reason IS NULL OR chat_lock_reason IN (
    'ADMIN_CLOSED_CASE','ADMIN_LOCKED_CHAT','CHAT_EXPIRED','CASE_CLOSED'
  )
);

-- ============= ADD MISSING COLUMNS TO MESSAGES =============

ALTER TABLE public.lost_property_messages
  ADD COLUMN IF NOT EXISTS attachments text[] DEFAULT '{}';

-- Add sender_type constraint
ALTER TABLE public.lost_property_messages DROP CONSTRAINT IF EXISTS valid_msg_sender_type;
ALTER TABLE public.lost_property_messages ADD CONSTRAINT valid_msg_sender_type CHECK (
  sender_type IN ('RIDER','DRIVER','SUPPORT','SYSTEM','customer','driver','system')
);

-- ============= INDEXES =============

CREATE INDEX IF NOT EXISTS idx_lp_cases_trip ON public.lost_property_cases(trip_id);
CREATE INDEX IF NOT EXISTS idx_lp_cases_driver ON public.lost_property_cases(driver_id);
CREATE INDEX IF NOT EXISTS idx_lp_cases_customer ON public.lost_property_cases(customer_id);
CREATE INDEX IF NOT EXISTS idx_lp_cases_status ON public.lost_property_cases(status);
CREATE INDEX IF NOT EXISTS idx_lp_cases_service_area ON public.lost_property_cases(service_area_id);
CREATE INDEX IF NOT EXISTS idx_lp_cases_cleanup ON public.lost_property_cases(photos_delete_at) WHERE photos_delete_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lp_messages_case ON public.lost_property_messages(case_id);
CREATE INDEX IF NOT EXISTS idx_lp_messages_case_created ON public.lost_property_messages(case_id, created_at);

-- ============= UPDATED_AT TRIGGER =============

CREATE OR REPLACE FUNCTION public.update_lost_property_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS trg_lost_property_updated_at ON public.lost_property_cases;
CREATE TRIGGER trg_lost_property_updated_at
  BEFORE UPDATE ON public.lost_property_cases
  FOR EACH ROW EXECUTE FUNCTION public.update_lost_property_updated_at();

-- ============= UPDATE RLS POLICIES =============

-- Drop old driver policy and recreate with direct driver_id check
DROP POLICY IF EXISTS "Drivers can view cases for their trips" ON public.lost_property_cases;
CREATE POLICY "Drivers can view assigned cases" ON public.lost_property_cases
  FOR SELECT TO authenticated
  USING (driver_id = public.current_driver_profile_id());

-- Add driver update policy (for marking found/not found)
DROP POLICY IF EXISTS "Drivers can update assigned cases" ON public.lost_property_cases;
CREATE POLICY "Drivers can update assigned cases" ON public.lost_property_cases
  FOR UPDATE TO authenticated
  USING (driver_id = public.current_driver_profile_id());

-- Fix messages: allow driver to view messages too
DROP POLICY IF EXISTS "Users can view messages for their cases" ON public.lost_property_messages;
CREATE POLICY "Case participants can view messages" ON public.lost_property_messages
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.lost_property_cases lpc
      WHERE lpc.id = case_id AND (
        lpc.customer_id = auth.uid()
        OR lpc.driver_id = public.current_driver_profile_id()
        OR public.has_role(auth.uid(), 'admin'::app_role)
      )
    )
  );

-- Allow drivers to send messages
DROP POLICY IF EXISTS "Users can send messages to their cases" ON public.lost_property_messages;
CREATE POLICY "Participants can send messages" ON public.lost_property_messages
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.lost_property_cases lpc
      WHERE lpc.id = case_id
      AND lpc.chat_enabled = true
      AND lpc.status != 'CLOSED'
      AND now() <= lpc.chat_expires_at
      AND (
        lpc.customer_id = auth.uid()
        OR lpc.driver_id = public.current_driver_profile_id()
        OR public.has_role(auth.uid(), 'admin'::app_role)
      )
    )
  );

-- Admin can manage all messages
DROP POLICY IF EXISTS "Admins can manage messages" ON public.lost_property_messages;
CREATE POLICY "Admins can manage messages" ON public.lost_property_messages
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));

-- ============= ADMIN UNREAD COUNT =============

CREATE OR REPLACE FUNCTION public.lost_property_admin_unread_count()
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COUNT(*)::integer FROM public.lost_property_cases
  WHERE status NOT IN ('CLOSED','closed')
  AND (
    status IN ('NEW')
    OR (status = 'SENT_TO_DRIVER' AND admin_viewed_at IS NULL)
    OR (admin_last_read_message_at IS NULL AND EXISTS (
      SELECT 1 FROM public.lost_property_messages m
      WHERE m.case_id = lost_property_cases.id AND m.sender_type IN ('RIDER','DRIVER','customer','driver')
    ))
    OR (admin_last_read_message_at IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.lost_property_messages m
      WHERE m.case_id = lost_property_cases.id AND m.sender_type IN ('RIDER','DRIVER','customer','driver')
      AND m.created_at > lost_property_cases.admin_last_read_message_at
    ))
  );
$$;

-- ============= PHOTO CLEANUP HELPER =============

CREATE OR REPLACE FUNCTION public.lost_property_get_cases_for_photo_cleanup()
RETURNS TABLE(case_id uuid, customer_photos text[], found_item_photos text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id, photos, found_item_photos
  FROM public.lost_property_cases
  WHERE photos_delete_at IS NOT NULL
  AND photos_delete_at <= now()
  AND (photos != '{}' OR found_item_photos != '{}');
$$;

-- ============= ENABLE REALTIME =============

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' AND tablename = 'lost_property_messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.lost_property_messages;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' AND tablename = 'lost_property_cases'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.lost_property_cases;
  END IF;
END $$;
