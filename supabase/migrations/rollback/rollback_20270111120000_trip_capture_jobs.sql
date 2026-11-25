-- Rollback: trip_capture_jobs durable capture queue.

DROP FUNCTION IF EXISTS public.list_trip_capture_jobs_alert_pending(integer);
DROP FUNCTION IF EXISTS public.mark_trip_capture_admin_alert_delivered(uuid, text);
DROP FUNCTION IF EXISTS public.update_trip_capture_job_after_attempt(uuid, uuid, text, timestamptz, text, text, text);
-- Legacy signature from earlier local draft (if present).
DROP FUNCTION IF EXISTS public.update_trip_capture_job_after_attempt(uuid, uuid, text, timestamptz, text, text);
DROP FUNCTION IF EXISTS public.bump_trip_capture_attempt(uuid, uuid);
DROP FUNCTION IF EXISTS public.claim_trip_capture_job_by_trip_id(uuid, uuid, integer);
DROP FUNCTION IF EXISTS public.claim_trip_capture_jobs(uuid, integer, integer);
DROP TABLE IF EXISTS public.trip_capture_jobs;
