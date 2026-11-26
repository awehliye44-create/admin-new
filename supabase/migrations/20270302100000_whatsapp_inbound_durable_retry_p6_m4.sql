-- P6 M4: WhatsApp durable inbound — never mark processed on workflow failure.
--
-- processed_at is set ONLY by the webhook after a successful workflow run.
-- A failed run records last_error, clears processing_started_at, and leaves
-- processed_at NULL so a Meta redelivery (23505 duplicate) can re-claim the
-- row with a compare-and-set, bounded by attempt_count.

ALTER TABLE public.whatsapp_inbound_messages
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS processing_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_error text;

COMMENT ON COLUMN public.whatsapp_inbound_messages.attempt_count IS
  'P6 M4: workflow attempts claimed for this inbound message (capped by webhook).';
COMMENT ON COLUMN public.whatsapp_inbound_messages.processing_started_at IS
  'P6 M4: set while a worker owns the message; cleared on failure; stale after TTL so a crashed worker can be re-claimed.';
COMMENT ON COLUMN public.whatsapp_inbound_messages.last_error IS
  'P6 M4: last workflow failure text (truncated). Never set on success.';

-- Rows already processed (or processed by the previous failure-swallowing code)
-- are left untouched. workflow_error rows from the old behaviour have processed_at
-- set and are intentionally NOT reopened (customer may have received a later reply).

CREATE INDEX IF NOT EXISTS whatsapp_inbound_messages_unprocessed_idx
  ON public.whatsapp_inbound_messages (received_at)
  WHERE processed_at IS NULL;

-- Atomic CAS claim for a duplicate delivery. Returns the new attempt_count when
-- the caller now owns the message; returns no row when it is already processed,
-- exhausted, or currently owned by a live (non-stale) worker.
CREATE OR REPLACE FUNCTION public.claim_whatsapp_inbound_retry(
  p_meta_message_id text,
  p_max_attempts integer DEFAULT 3,
  p_stale_after_seconds integer DEFAULT 120
)
RETURNS TABLE (attempt_count integer)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  UPDATE public.whatsapp_inbound_messages m
  SET attempt_count = m.attempt_count + 1,
      processing_started_at = now()
  WHERE m.meta_message_id = p_meta_message_id
    AND m.processed_at IS NULL
    AND m.attempt_count < GREATEST(1, p_max_attempts)
    AND (
      m.processing_started_at IS NULL
      OR m.processing_started_at < now() - make_interval(secs => GREATEST(1, p_stale_after_seconds))
    )
  RETURNING m.attempt_count;
$$;

REVOKE ALL ON FUNCTION public.claim_whatsapp_inbound_retry(text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_whatsapp_inbound_retry(text, integer, integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_whatsapp_inbound_retry(text, integer, integer) TO service_role;
