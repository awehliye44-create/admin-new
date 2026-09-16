CREATE OR REPLACE FUNCTION public.audit_logs_retention_cleanup(p_keep_days integer DEFAULT 90)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM public.audit_logs
  WHERE created_at < now() - make_interval(days => GREATEST(p_keep_days, 30));
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$function$;

REVOKE ALL ON FUNCTION public.audit_logs_retention_cleanup(integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.audit_logs_retention_cleanup(integer) FROM anon;
REVOKE EXECUTE ON FUNCTION public.audit_logs_retention_cleanup(integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.audit_logs_retention_cleanup(integer) TO service_role;

SELECT cron.schedule(
  'audit-logs-retention-daily',
  '20 3 * * *',
  $$SELECT public.audit_logs_retention_cleanup(90);$$
);

SELECT public.audit_logs_retention_cleanup(90);