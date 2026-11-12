-- Phase 5 drain-first rollback helper (staging / controlled disable).
-- Do NOT drop columns or redeploy pre-Phase-5 Edge until pending sessions drain.
--
-- Order:
-- 1) Disable new arming (flags below) — existing deadlines keep ticking (no extension).
-- 2) Wait until no trips have scheduled_ack_status = 'pending' (or force-timeout past deadline).
-- 3) Only then redeploy prior Edge / apply column rollback if required.
--
-- Late acknowledgements remain rejected by scheduled-checkin CAS (deadline not extended).

UPDATE public.global_dispatch_settings
SET
  scheduled_departure_ack_enabled = false,
  jit_auto_activate_enabled = false,
  updated_at = now()
WHERE singleton = true;

-- Inventory of sessions that must complete or expire before Edge rollback.
-- SELECT id, scheduled_ack_deadline_at, scheduled_ack_driver_id, scheduled_status
-- FROM public.trips
-- WHERE scheduled_ack_status = 'pending'
-- ORDER BY scheduled_ack_deadline_at NULLS LAST;

-- Optional operator force-timeout for past-deadline pending rows (does not extend window):
-- UPDATE public.trips t
-- SET
--   scheduled_ack_status = 'timed_out',
--   scheduled_ack_resolved_at = now(),
--   scheduled_ack_resolution_reason = 'drain_rollback_force_timeout',
--   updated_at = now()
-- WHERE scheduled_ack_status = 'pending'
--   AND scheduled_ack_deadline_at IS NOT NULL
--   AND scheduled_ack_deadline_at <= now();
