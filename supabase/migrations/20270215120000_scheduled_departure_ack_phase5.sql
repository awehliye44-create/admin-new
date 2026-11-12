-- Phase 5: Urgent Scheduled Departure Acknowledgement columns.
-- NOT applied to production until Phase 5 deploy is explicitly approved.
-- Keeps jit_auto_activate_enabled=false (no-ack en_route remains impossible).
-- Reuses awaiting_activation_accept + exclusive rescue → instant dispatch.

ALTER TABLE public.global_dispatch_settings
  ADD COLUMN IF NOT EXISTS scheduled_departure_ack_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS scheduled_departure_ack_seconds integer NOT NULL DEFAULT 45,
  ADD COLUMN IF NOT EXISTS scheduled_departure_ack_grace_seconds integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.global_dispatch_settings.scheduled_departure_ack_enabled IS
  'Phase 5: MUST stay false until compatible Driver OTA adoption is verified. When true, JIT due arms exactly 45s departure acknowledgement (Heading to Pickup / Cancel). When false, Phase 4 exclusive NRO (lockedDriverResponseMinutes) remains.';
COMMENT ON COLUMN public.global_dispatch_settings.scheduled_departure_ack_seconds IS
  'Phase 5: backend-authoritative departure acknowledgement countdown seconds (default 45). Offer expires_at and UI countdown must match this deadline.';
COMMENT ON COLUMN public.global_dispatch_settings.scheduled_departure_ack_grace_seconds IS
  'DEPRECATED: must not extend the driver acknowledgement window. Authoritative deadline is exactly scheduled_departure_ack_seconds. Default 0.';

UPDATE public.global_dispatch_settings
SET
  scheduled_departure_ack_enabled = false,
  scheduled_departure_ack_seconds = COALESCE(scheduled_departure_ack_seconds, 45),
  scheduled_departure_ack_grace_seconds = 0,
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
