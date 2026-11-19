-- Bug #48: Admin must be alerted on sustained stop-workflow HTTP 500s.
-- ops_detect_5xx_spikes already watches http_status >= 500 (any source).
-- ops_detect_edge_function_failures previously omitted source 'stop-workflow'
-- and only counted level error/fatal — finishEdgeRequestLog now writes both.

CREATE OR REPLACE FUNCTION public.ops_detect_edge_function_failures()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_count int := 0; r record;
BEGIN
  FOR r IN
    SELECT source, count(*) AS fail_count
    FROM public.ops_logs
    WHERE created_at > now() - interval '30 minutes'
      AND is_synthetic = false
      AND (
        level IN ('error', 'fatal')
        OR COALESCE(http_status, 0) >= 500
      )
      AND (
        source = 'stop-workflow'
        OR source = 'accept-offer'
        OR source = 'scheduled-checkin'
        OR source LIKE '%-trip'
        OR source LIKE '%dispatch%'
        OR source LIKE '%payment%'
        OR source LIKE '%payout%'
        OR source LIKE '%commission%'
        OR source LIKE '%driver-%'
        OR source LIKE '%estimate-%'
        OR source LIKE '%calculate-%'
        OR source LIKE '%capture-%'
        OR source LIKE '%cancel-%'
        OR source LIKE '%complete-%'
        OR source LIKE '%accept-%'
        OR source LIKE '%decline-%'
        OR source LIKE '%find-%'
        OR source LIKE '%resolve-%'
        OR source LIKE '%schedule-%'
        OR source LIKE '%upsert-%'
        OR source LIKE '%validate-%'
        OR source LIKE '%document-%'
        OR source LIKE '%ops-%'
        OR source LIKE '%qr-%'
        OR source LIKE '%public-%'
        OR source LIKE '%handle-%'
        OR source LIKE '%workflow%'
      )
    GROUP BY source
    HAVING count(*) >= 3
  LOOP
    PERFORM public.ops_upsert_alert(
      'edge_fn_failure:' || r.source || ':' || date_trunc('hour', now())::text,
      'backend', 'critical', 'system', 'backend',
      'Edge Function Failures: ' || r.source,
      r.fail_count || ' failures from edge function ' || r.source || ' in last 30 min',
      NULL, NULL, NULL, NULL, NULL, NULL,
      jsonb_build_object('function_name', r.source, 'fail_count', r.fail_count)
    );
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;
