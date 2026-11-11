-- Durable post-complete Revolut capture jobs.
-- stop-workflow complete_trip enqueues after status=completed (+ settlement),
-- then returns so the Driver can open Rate Passenger without awaiting capture.
-- process-trip-capture-jobs claims and runs the existing finalize-trip-and-capture
-- flow (idempotent; same outcome / failure recovery as inline complete_trip).
-- Tip-window trips are NOT enqueued here (existing tip-window sweeper owns those).
--
-- claim_count increments on every claim/reclaim (crash recovery).
-- capture_attempt_count increments only when finalize-trip-and-capture is invoked.
-- failed_terminal always stamps admin_alert_pending; alert delivery clears it.
--
-- LOCAL ONLY until explicitly applied — do not deploy/apply to production from this change set.

CREATE TABLE IF NOT EXISTS public.trip_capture_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES public.trips(id),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'claimed', 'done', 'failed_terminal')),
  source text NOT NULL DEFAULT 'stop-workflow:complete_trip',
  tip_pence integer NOT NULL DEFAULT 0 CHECK (tip_pence >= 0),
  -- Reclaim / lease counters — crash before capture must NOT burn capture budget.
  claim_count integer NOT NULL DEFAULT 0 CHECK (claim_count >= 0),
  -- Actual finalize-trip-and-capture invocations only.
  capture_attempt_count integer NOT NULL DEFAULT 0 CHECK (capture_attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claim_token uuid,
  claimed_at timestamptz,
  claim_expires_at timestamptz,
  last_error text,
  last_finalize_status text,
  -- Durable admin alert: set on failed_terminal; cleared only after durable delivery
  -- (or cooldown dedupe). Cron retries while pending.
  admin_alert_pending boolean NOT NULL DEFAULT false,
  admin_alerted_at timestamptz,
  admin_alert_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT trip_capture_jobs_trip_id_unique UNIQUE (trip_id)
);

CREATE INDEX IF NOT EXISTS idx_trip_capture_jobs_poller
  ON public.trip_capture_jobs (next_attempt_at, claim_expires_at)
  WHERE status IN ('queued', 'claimed');

CREATE INDEX IF NOT EXISTS idx_trip_capture_jobs_alert_pending
  ON public.trip_capture_jobs (updated_at)
  WHERE admin_alert_pending = true AND status = 'failed_terminal';

ALTER TABLE public.trip_capture_jobs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.trip_capture_jobs FROM PUBLIC;
REVOKE ALL ON TABLE public.trip_capture_jobs FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.trip_capture_jobs TO service_role;

-- Atomic claim for cron / accelerator workers.
-- Increments claim_count only — never capture_attempt_count.
CREATE OR REPLACE FUNCTION public.claim_trip_capture_jobs(
  p_claim_token uuid,
  p_claim_ttl_seconds integer DEFAULT 120,
  p_limit integer DEFAULT 20
)
RETURNS TABLE (
  job_id uuid,
  trip_id uuid,
  tip_pence integer,
  claim_count integer,
  capture_attempt_count integer,
  source text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := now();
  v_ttl integer := GREATEST(30, LEAST(COALESCE(p_claim_ttl_seconds, 120), 600));
  v_limit integer := GREATEST(1, LEAST(COALESCE(p_limit, 20), 50));
BEGIN
  IF p_claim_token IS NULL THEN
    RAISE EXCEPTION 'claim_token required';
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT j.id
    FROM public.trip_capture_jobs j
    WHERE j.status IN ('queued', 'claimed')
      AND j.next_attempt_at <= v_now
      AND (
        j.claim_expires_at IS NULL
        OR j.claim_expires_at <= v_now
      )
    ORDER BY j.next_attempt_at ASC, j.created_at ASC
    LIMIT v_limit
    FOR UPDATE SKIP LOCKED
  ),
  claimed AS (
    UPDATE public.trip_capture_jobs j
    SET
      status = 'claimed',
      claim_token = p_claim_token,
      claimed_at = v_now,
      claim_expires_at = v_now + make_interval(secs => v_ttl),
      claim_count = j.claim_count + 1,
      updated_at = v_now
    FROM candidates c
    WHERE j.id = c.id
      AND j.status IN ('queued', 'claimed')
      AND (
        j.claim_expires_at IS NULL
        OR j.claim_expires_at <= v_now
      )
    RETURNING
      j.id AS job_id,
      j.trip_id,
      j.tip_pence,
      j.claim_count,
      j.capture_attempt_count,
      j.source
  )
  SELECT
    claimed.job_id,
    claimed.trip_id,
    claimed.tip_pence,
    claimed.claim_count,
    claimed.capture_attempt_count,
    claimed.source
  FROM claimed;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_trip_capture_jobs(uuid, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_trip_capture_jobs(uuid, integer, integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_trip_capture_jobs(uuid, integer, integer) TO service_role;

-- Claim one trip's job (waitUntil accelerator after durable enqueue).
CREATE OR REPLACE FUNCTION public.claim_trip_capture_job_by_trip_id(
  p_trip_id uuid,
  p_claim_token uuid,
  p_claim_ttl_seconds integer DEFAULT 120
)
RETURNS TABLE (
  job_id uuid,
  trip_id uuid,
  tip_pence integer,
  claim_count integer,
  capture_attempt_count integer,
  source text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := now();
  v_ttl integer := GREATEST(30, LEAST(COALESCE(p_claim_ttl_seconds, 120), 600));
BEGIN
  IF p_trip_id IS NULL OR p_claim_token IS NULL THEN
    RAISE EXCEPTION 'trip_id and claim_token required';
  END IF;

  RETURN QUERY
  WITH claimed AS (
    UPDATE public.trip_capture_jobs j
    SET
      status = 'claimed',
      claim_token = p_claim_token,
      claimed_at = v_now,
      claim_expires_at = v_now + make_interval(secs => v_ttl),
      claim_count = j.claim_count + 1,
      updated_at = v_now
    WHERE j.trip_id = p_trip_id
      AND j.status IN ('queued', 'claimed')
      AND j.next_attempt_at <= v_now
      AND (
        j.claim_expires_at IS NULL
        OR j.claim_expires_at <= v_now
      )
    RETURNING
      j.id AS job_id,
      j.trip_id,
      j.tip_pence,
      j.claim_count,
      j.capture_attempt_count,
      j.source
  )
  SELECT
    claimed.job_id,
    claimed.trip_id,
    claimed.tip_pence,
    claimed.claim_count,
    claimed.capture_attempt_count,
    claimed.source
  FROM claimed;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_trip_capture_job_by_trip_id(uuid, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_trip_capture_job_by_trip_id(uuid, uuid, integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_trip_capture_job_by_trip_id(uuid, uuid, integer) TO service_role;

-- Bump capture budget only immediately before finalize-trip-and-capture.
CREATE OR REPLACE FUNCTION public.bump_trip_capture_attempt(
  p_job_id uuid,
  p_claim_token uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE public.trip_capture_jobs j
  SET
    capture_attempt_count = j.capture_attempt_count + 1,
    updated_at = now()
  WHERE j.id = p_job_id
    AND j.claim_token = p_claim_token
    AND j.status = 'claimed'
  RETURNING j.capture_attempt_count INTO v_count;

  IF v_count IS NULL THEN
    RAISE EXCEPTION 'bump_trip_capture_attempt: job not claimed by token';
  END IF;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.bump_trip_capture_attempt(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bump_trip_capture_attempt(uuid, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bump_trip_capture_attempt(uuid, uuid) TO service_role;

-- Finish or reschedule under claim ownership.
-- failed_terminal always sets admin_alert_pending=true (alert delivery is separate).
CREATE OR REPLACE FUNCTION public.update_trip_capture_job_after_attempt(
  p_job_id uuid,
  p_claim_token uuid,
  p_status text,
  p_next_attempt_at timestamptz DEFAULT NULL,
  p_last_error text DEFAULT NULL,
  p_last_finalize_status text DEFAULT NULL,
  p_admin_alert_key text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated bigint;
  v_now timestamptz := now();
BEGIN
  IF p_status NOT IN ('queued', 'done', 'failed_terminal') THEN
    RAISE EXCEPTION 'invalid trip_capture_jobs status %', p_status;
  END IF;

  UPDATE public.trip_capture_jobs j
  SET
    status = p_status,
    next_attempt_at = CASE
      WHEN p_status = 'queued' THEN COALESCE(p_next_attempt_at, v_now + interval '30 seconds')
      ELSE j.next_attempt_at
    END,
    last_error = CASE WHEN p_last_error IS NULL THEN j.last_error ELSE left(p_last_error, 2000) END,
    last_finalize_status = CASE
      WHEN p_last_finalize_status IS NULL THEN j.last_finalize_status
      ELSE left(p_last_finalize_status, 200)
    END,
    claim_token = CASE WHEN p_status = 'queued' THEN NULL ELSE j.claim_token END,
    claim_expires_at = CASE WHEN p_status = 'queued' THEN NULL ELSE j.claim_expires_at END,
    completed_at = CASE
      WHEN p_status IN ('done', 'failed_terminal') THEN v_now
      ELSE j.completed_at
    END,
    admin_alert_pending = CASE
      WHEN p_status = 'failed_terminal' THEN true
      ELSE j.admin_alert_pending
    END,
    admin_alert_key = CASE
      WHEN p_status = 'failed_terminal' THEN COALESCE(p_admin_alert_key, j.admin_alert_key)
      ELSE j.admin_alert_key
    END,
    updated_at = v_now
  WHERE j.id = p_job_id
    AND j.claim_token = p_claim_token
    AND j.status = 'claimed';

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.update_trip_capture_job_after_attempt(uuid, uuid, text, timestamptz, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_trip_capture_job_after_attempt(uuid, uuid, text, timestamptz, text, text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_trip_capture_job_after_attempt(uuid, uuid, text, timestamptz, text, text, text) TO service_role;

-- Clear pending alert after durable delivery (or cooldown dedupe).
CREATE OR REPLACE FUNCTION public.mark_trip_capture_admin_alert_delivered(
  p_job_id uuid,
  p_alert_key text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated bigint;
  v_now timestamptz := now();
BEGIN
  UPDATE public.trip_capture_jobs j
  SET
    admin_alert_pending = false,
    admin_alerted_at = v_now,
    admin_alert_key = COALESCE(p_alert_key, j.admin_alert_key),
    updated_at = v_now
  WHERE j.id = p_job_id
    AND j.status = 'failed_terminal'
    AND j.admin_alert_pending = true;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_trip_capture_admin_alert_delivered(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_trip_capture_admin_alert_delivered(uuid, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_trip_capture_admin_alert_delivered(uuid, text) TO service_role;

-- List failed_terminal rows still needing alert delivery (cron retry).
CREATE OR REPLACE FUNCTION public.list_trip_capture_jobs_alert_pending(
  p_limit integer DEFAULT 20
)
RETURNS TABLE (
  job_id uuid,
  trip_id uuid,
  last_error text,
  last_finalize_status text,
  admin_alert_key text,
  capture_attempt_count integer,
  claim_count integer,
  source text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit integer := GREATEST(1, LEAST(COALESCE(p_limit, 20), 50));
BEGIN
  RETURN QUERY
  SELECT
    j.id AS job_id,
    j.trip_id,
    j.last_error,
    j.last_finalize_status,
    j.admin_alert_key,
    j.capture_attempt_count,
    j.claim_count,
    j.source
  FROM public.trip_capture_jobs j
  WHERE j.status = 'failed_terminal'
    AND j.admin_alert_pending = true
  ORDER BY j.updated_at ASC
  LIMIT v_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.list_trip_capture_jobs_alert_pending(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_trip_capture_jobs_alert_pending(integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_trip_capture_jobs_alert_pending(integer) TO service_role;
