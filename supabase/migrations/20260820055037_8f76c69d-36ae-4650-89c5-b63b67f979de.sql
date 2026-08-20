ALTER TABLE public.support_conversations
  ADD COLUMN IF NOT EXISTS guest_session_token TEXT,
  ADD COLUMN IF NOT EXISTS guest_name TEXT,
  ADD COLUMN IF NOT EXISTS guest_email TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS support_conversations_guest_session_token_key
  ON public.support_conversations (guest_session_token)
  WHERE guest_session_token IS NOT NULL;

ALTER TABLE public.support_conversations DROP CONSTRAINT IF EXISTS support_conversations_channel_check;
ALTER TABLE public.support_conversations
  ADD CONSTRAINT support_conversations_channel_check
  CHECK (channel = ANY (ARRAY['in_app'::text, 'email'::text, 'phone'::text, 'whatsapp'::text, 'website'::text]));

ALTER TABLE public.support_conversations DROP CONSTRAINT IF EXISTS valid_user_reference;
ALTER TABLE public.support_conversations
  ADD CONSTRAINT valid_user_reference CHECK (
    ((user_type = 'customer' AND customer_id IS NOT NULL AND driver_id IS NULL)
     OR (user_type = 'customer' AND channel = 'whatsapp' AND driver_id IS NULL)
     OR (user_type = 'customer' AND channel = 'website' AND driver_id IS NULL)
     OR (user_type = 'driver' AND driver_id IS NOT NULL AND customer_id IS NULL))
  );