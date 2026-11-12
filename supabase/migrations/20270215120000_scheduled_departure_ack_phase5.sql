-- Phase 5: Urgent Scheduled Departure Acknowledgement columns.
-- NOT applied to production until Phase 5 deploy is explicitly approved.
-- Keeps jit_auto_activate_enabled=false (no-ack en_route remains impossible).
-- Reuses awaiting_activation_accept + exclusive rescue → instant dispatch.

ALTER TABLE public.global_dispatch_settings
  ADD COLUMN IF NOT EXISTS scheduled_departure_ack_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS scheduled_departure_ack_seconds integer NOT NULL DEFAULT 45,
  ADD COLUMN IF NOT EXISTS scheduled_departure_ack_grace_seconds integer NOT NULL DEFAULT 10;

COMMENT ON COLUMN public.global_dispatch_settings.scheduled_departure_ack_enabled IS
  'Phase 5: when true, JIT due arms 45s departure acknowledgement (Heading to Pickup / Cancel). When false, falls back to Phase 4 exclusive NRO arm with lockedDriverResponseMinutes.';
COMMENT ON COLUMN public.global_dispatch_settings.scheduled_departure_ack_seconds IS
  'Phase 5: backend-authoritative departure acknowledgement countdown seconds (default 45).';
COMMENT ON COLUMN public.global_dispatch_settings.scheduled_departure_ack_grace_seconds IS
  'Phase 5: grace after deadline before timeout rescue (in-flight ack / reconnect). Default 10.';

UPDATE public.global_dispatch_settings
SET
  scheduled_departure_ack_enabled = COALESCE(scheduled_departure_ack_enabled, true),
  scheduled_departure_ack_seconds = COALESCE(scheduled_departure_ack_seconds, 45),
  scheduled_departure_ack_grace_seconds = COALESCE(scheduled_departure_ack_grace_seconds, 10),
  jit_auto_activate_enabled = false
WHERE singleton = true;

ALTER TABLE public.trips
  ADD COLUMN IF NOT EXISTS scheduled_ack_status text,
  ADD COLUMN IF NOT EXISTS scheduled_ack_deadline_at timestamptz,
  ADD COLUMN IF NOT EXISTS scheduled_ack_armed_at timestamptz,
  ADD COLUMN IF NOT EXISTS scheduled_ack_acknowledged_at timestamptz,
  ADD COLUMN IF NOT EXISTS scheduled_ack_resolved_at timestamptz,
  ADD COLUMN IF NOT EXISTS scheduled_ack_resolution_reason text,
  ADD COLUMN IF NOT EXISTS scheduled_ack_driver_id uuid,
  ADD COLUMN IF NOT EXISTS scheduled_ack_nonce uuid;

COMMENT ON COLUMN public.trips.scheduled_ack_status IS
  'Phase 5: pending | acknowledged | timed_out | cancelled | declined | superseded. Null when no departure ack armed.';
COMMENT ON COLUMN public.trips.scheduled_ack_deadline_at IS
  'Phase 5: backend-authoritative acknowledgement deadline (UTC). Client countdown must use this.';
COMMENT ON COLUMN public.trips.scheduled_ack_nonce IS
  'Phase 5: binds push/arm to one acknowledgement window.';

CREATE INDEX IF NOT EXISTS idx_trips_scheduled_ack_deadline_pending
  ON public.trips (scheduled_ack_deadline_at)
  WHERE scheduled_ack_status = 'pending'
    AND confirmed_driver_id IS NOT NULL
    AND driver_id IS NULL
    AND scheduled_status = 'awaiting_activation_accept';
