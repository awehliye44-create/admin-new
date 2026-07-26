-- Trip communication call-session hardening (additive).
-- Runtime max duration SSOT is enforced in application code at 240 seconds.
-- DB settings values are not authoritative for enforcement.

-- ---------------------------------------------------------------------------
-- voip_call_logs: session lifecycle columns
-- ---------------------------------------------------------------------------
ALTER TABLE public.voip_call_logs
  ADD COLUMN IF NOT EXISTS room_name TEXT,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS initiator_role TEXT,
  ADD COLUMN IF NOT EXISTS initiator_user_id UUID,
  ADD COLUMN IF NOT EXISTS connected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS incoming_push_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS participants_joined INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS termination_attempted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS provider_room_sid TEXT;

COMMENT ON COLUMN public.voip_call_logs.room_name IS
  'Opaque LiveKit room name; server-only join context, never push payloads.';
COMMENT ON COLUMN public.voip_call_logs.expires_at IS
  'Authoritative session expiry; typically connected_at + 240s.';

-- Idempotent start reuse per trip + initiator + key
CREATE UNIQUE INDEX IF NOT EXISTS voip_call_logs_idempotency_uidx
  ON public.voip_call_logs (trip_id, initiator_user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND initiator_user_id IS NOT NULL;

-- One non-terminal VoIP session per trip
CREATE UNIQUE INDEX IF NOT EXISTS voip_call_logs_one_active_per_trip_uidx
  ON public.voip_call_logs (trip_id)
  WHERE ended_at IS NULL
    AND status IN ('requested', 'ringing', 'connecting', 'active');

CREATE INDEX IF NOT EXISTS voip_call_logs_expires_active_idx
  ON public.voip_call_logs (expires_at)
  WHERE ended_at IS NULL
    AND status IN ('requested', 'ringing', 'connecting', 'active');

CREATE INDEX IF NOT EXISTS voip_call_logs_room_name_idx
  ON public.voip_call_logs (room_name)
  WHERE room_name IS NOT NULL;

-- ---------------------------------------------------------------------------
-- call_masking_call_logs: expiry / connected / termination markers
-- ---------------------------------------------------------------------------
ALTER TABLE public.call_masking_call_logs
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS connected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS termination_attempted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE INDEX IF NOT EXISTS call_masking_call_logs_expires_active_idx
  ON public.call_masking_call_logs (expires_at)
  WHERE status = 'active' AND call_end IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS call_masking_call_logs_one_active_per_booking_uidx
  ON public.call_masking_call_logs (booking_id)
  WHERE status = 'active' AND call_end IS NULL AND booking_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- LiveKit webhook event dedupe
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.livekit_webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  room_name TEXT,
  call_log_id UUID REFERENCES public.voip_call_logs(id) ON DELETE SET NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT livekit_webhook_events_event_id_key UNIQUE (event_id)
);

CREATE INDEX IF NOT EXISTS livekit_webhook_events_call_log_idx
  ON public.livekit_webhook_events (call_log_id, processed_at DESC);

ALTER TABLE public.livekit_webhook_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "LiveKit webhook events managed by service role"
  ON public.livekit_webhook_events FOR ALL TO service_role
  USING (true) WITH CHECK (true);

GRANT ALL ON public.livekit_webhook_events TO service_role;

-- Report (non-destructive) settings rows that are not 240s — enforcement ignores these.
DO $$
DECLARE
  mismatched INTEGER;
BEGIN
  SELECT COUNT(*) INTO mismatched
  FROM public.service_area_communication_settings
  WHERE maximum_call_duration_seconds IS DISTINCT FROM 240;

  RAISE NOTICE 'service_area_communication_settings rows with maximum_call_duration_seconds <> 240: %', mismatched;
END $$;
