-- Throwaway proof for the recovery-job health statement.
-- A healthy recent result inserts nothing. A missing, stale, or failed result
-- inserts one open alert. A repeat refreshes that row instead of adding another.

CREATE SCHEMA IF NOT EXISTS net;

CREATE TABLE IF NOT EXISTS net._http_response (
  id bigserial PRIMARY KEY,
  status_code integer,
  content text,
  created timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.ops_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fingerprint text NOT NULL,
  category text NOT NULL,
  severity text NOT NULL DEFAULT 'critical',
  status text NOT NULL DEFAULT 'open',
  source text NOT NULL DEFAULT 'system',
  title text NOT NULL,
  description text,
  metadata jsonb,
  fingerprint_count integer NOT NULL DEFAULT 1,
  last_detected_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP INDEX IF EXISTS public.ops_alerts_fingerprint_open_idx;
CREATE UNIQUE INDEX ops_alerts_fingerprint_open_idx
  ON public.ops_alerts (fingerprint)
  WHERE status = ANY (ARRAY['open'::text, 'acknowledged'::text]);

CREATE OR REPLACE FUNCTION public._test_shortfall_recovery_health()
RETURNS void
LANGUAGE plpgsql
AS $fn$
BEGIN
  INSERT INTO public.ops_alerts (
    fingerprint, category, severity, status, source, title, description, metadata
  )
  SELECT
    'finance:shortfall_recovery_job_unhealthy',
    'payment',
    'critical',
    'open',
    'system',
    'Waiting shortfall recovery job needs attention',
    'The five-minute recovery call did not return ok within 12 minutes.',
    jsonb_build_object('money_moved', false, 'provider_called', false)
  WHERE NOT EXISTS (
    SELECT 1
    FROM net._http_response
    WHERE content LIKE '%"money_moved":false%'
      AND content LIKE '%"provider_called":false%'
      AND content LIKE '%"examined":%'
      AND status_code = 200
      AND created >= now() - interval '12 minutes'
      AND coalesce(content::jsonb->>'ok', '') = 'true'
  )
  ON CONFLICT (fingerprint) WHERE status = ANY (ARRAY['open'::text, 'acknowledged'::text])
  DO UPDATE SET
    fingerprint_count = public.ops_alerts.fingerprint_count + 1,
    last_detected_at = now(),
    description = EXCLUDED.description;
END;
$fn$;

TRUNCATE public.ops_alerts, net._http_response;

-- No result yet: one alert.
SELECT public._test_shortfall_recovery_health();
-- Repeat while still unhealthy: same row, count 2.
SELECT public._test_shortfall_recovery_health();

-- A fresh successful run: no new row and no count bump.
INSERT INTO net._http_response (status_code, content, created)
VALUES (
  200,
  '{"ok":true,"money_moved":false,"provider_called":false,"examined":0}',
  now()
);
SELECT public._test_shortfall_recovery_health();

-- A failed result and no fresh success: refresh the same row to count 3.
UPDATE net._http_response SET created = now() - interval '13 minutes';
INSERT INTO net._http_response (status_code, content, created)
VALUES (
  500,
  '{"ok":false,"money_moved":false,"provider_called":false,"examined":0}',
  now()
);
SELECT public._test_shortfall_recovery_health();

DO $$
DECLARE
  v_rows integer;
  v_count integer;
BEGIN
  SELECT count(*), max(fingerprint_count)
  INTO v_rows, v_count
  FROM public.ops_alerts
  WHERE fingerprint = 'finance:shortfall_recovery_job_unhealthy'
    AND status = 'open';
  IF v_rows IS DISTINCT FROM 1 OR v_count IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'health alert drifted: rows=% count=%', v_rows, v_count;
  END IF;
  RAISE NOTICE 'shortfall recovery health: one open alert, count 3';
END;
$$;
