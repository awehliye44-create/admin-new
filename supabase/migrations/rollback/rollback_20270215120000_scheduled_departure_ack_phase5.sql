-- Rollback Phase 5 departure-ack columns. Does not restore converted trips.
DROP INDEX IF EXISTS public.idx_trips_scheduled_ack_deadline_pending;

ALTER TABLE public.trips
  DROP COLUMN IF EXISTS scheduled_ack_status,
  DROP COLUMN IF EXISTS scheduled_ack_deadline_at,
  DROP COLUMN IF EXISTS scheduled_ack_armed_at,
  DROP COLUMN IF EXISTS scheduled_ack_acknowledged_at,
  DROP COLUMN IF EXISTS scheduled_ack_resolved_at,
  DROP COLUMN IF EXISTS scheduled_ack_resolution_reason,
  DROP COLUMN IF EXISTS scheduled_ack_driver_id,
  DROP COLUMN IF EXISTS scheduled_ack_nonce;

ALTER TABLE public.global_dispatch_settings
  DROP COLUMN IF EXISTS scheduled_departure_ack_enabled,
  DROP COLUMN IF EXISTS scheduled_departure_ack_seconds,
  DROP COLUMN IF EXISTS scheduled_departure_ack_grace_seconds;
