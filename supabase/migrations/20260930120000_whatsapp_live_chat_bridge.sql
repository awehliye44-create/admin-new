-- WhatsApp → Live Chat bridge migration
-- Adds WhatsApp channel support to existing support tables and booking session lifecycle
-- to whatsapp_conversations. No existing table/column is dropped or renamed.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. support_conversations: add 'whatsapp' to channel check + add wa_id column
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.support_conversations
  DROP CONSTRAINT IF EXISTS support_conversations_channel_check;

ALTER TABLE public.support_conversations
  ADD CONSTRAINT support_conversations_channel_check
    CHECK (channel = ANY (ARRAY['in_app','email','phone','whatsapp']));

-- wa_id stores the WhatsApp sender ID for channel = 'whatsapp' conversations.
ALTER TABLE public.support_conversations
  ADD COLUMN IF NOT EXISTS wa_id text;

CREATE INDEX IF NOT EXISTS support_conversations_wa_id_idx
  ON public.support_conversations (wa_id)
  WHERE wa_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. support_conversations: relax valid_user_reference for WhatsApp guests
--    WhatsApp customers may not have a registered ONECAB account (customer_id
--    can be NULL when channel = 'whatsapp'). For all other channels the
--    existing rule (customer_id required for user_type=customer) is preserved.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.support_conversations
  DROP CONSTRAINT IF EXISTS valid_user_reference;

ALTER TABLE public.support_conversations
  ADD CONSTRAINT valid_user_reference CHECK (
    (
      user_type = 'customer'
      AND customer_id IS NOT NULL
      AND driver_id IS NULL
    )
    OR (
      user_type = 'customer'
      AND channel = 'whatsapp'
      AND driver_id IS NULL
    )
    OR (
      user_type = 'driver'
      AND driver_id IS NOT NULL
      AND customer_id IS NULL
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. whatsapp_conversations: bridge + booking session lifecycle columns
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.whatsapp_conversations
  ADD COLUMN IF NOT EXISTS support_conversation_id uuid
    REFERENCES public.support_conversations(id) ON DELETE SET NULL;

ALTER TABLE public.whatsapp_conversations
  ADD COLUMN IF NOT EXISTS booking_session_started_at timestamptz;

ALTER TABLE public.whatsapp_conversations
  ADD COLUMN IF NOT EXISTS booking_session_expires_at timestamptz;

CREATE INDEX IF NOT EXISTS whatsapp_conversations_support_conv_idx
  ON public.whatsapp_conversations (support_conversation_id)
  WHERE support_conversation_id IS NOT NULL;

-- Index for booking expiry sweep: only rows in 'book' state with past expiry.
CREATE INDEX IF NOT EXISTS whatsapp_conversations_booking_expiry_idx
  ON public.whatsapp_conversations (booking_session_expires_at)
  WHERE workflow_state = 'book' AND booking_session_expires_at IS NOT NULL;

COMMENT ON COLUMN public.whatsapp_conversations.support_conversation_id IS
  'FK to support_conversations when workflow_state=support. NULL otherwise.';

COMMENT ON COLUMN public.whatsapp_conversations.booking_session_started_at IS
  'When the current booking wizard session began. Cleared on idle/completion/expiry.';

COMMENT ON COLUMN public.whatsapp_conversations.booking_session_expires_at IS
  'Absolute deadline for the current booking session. Null when not in book state.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Extend workflow_state check to include 'completed' terminal session state
--    (booking wizard completed = session done, not the trip itself)
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.whatsapp_conversations
  DROP CONSTRAINT IF EXISTS whatsapp_conversations_workflow_state_check;

ALTER TABLE public.whatsapp_conversations
  ADD CONSTRAINT whatsapp_conversations_workflow_state_check
    CHECK (workflow_state IN ('new','idle','book','track','support'));

-- Note: 'completed' booking → we immediately set workflow_state='idle'.
-- The distinction is captured by booking_session_started_at being non-null
-- with no open booking_session_expires_at. No extra terminal state needed.

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. RLS: service_role can read/write all support rows (already granted via
--    existing policies — nothing new needed for service_role).
--    Admin anon/authenticated role needs SELECT on support_conversations with
--    wa_id. Existing RLS policies cover this via the auth.role() checks already
--    present; no additional policy needed.
-- ─────────────────────────────────────────────────────────────────────────────
