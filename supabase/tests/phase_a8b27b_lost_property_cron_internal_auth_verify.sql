-- Phase A8B27B simulation only. BEGIN/ROLLBACK.
-- Creates a synthetic Vault secret transactionally, proves helper shape/ACL,
-- rewrites cron commands transactionally, does NOT invoke net.http_post,
-- and restores live jobs/secrets via ROLLBACK.
-- Never prints token values.

BEGIN;

CREATE TEMP TABLE a8b27b_cron_backup ON COMMIT DROP AS
SELECT jobid, jobname, schedule, command, active
FROM cron.job
WHERE jobid IN (7, 8);

DO $$
DECLARE
  v_token text := 'a8b27b-synthetic-lost-property-cron-token-0001';
  h jsonb;
  v_auth int;
BEGIN
  IF length(v_token) < 32 THEN
    RAISE EXCEPTION 'A8B27B SIM HARD STOP: synthetic token too short';
  END IF;

  -- Synthetic vault secret (rolled back)
  PERFORM vault.create_secret(
    v_token,
    'onecab_internal_lost_property_cron_token',
    'A8B27B synthetic only'
  );

  CREATE OR REPLACE FUNCTION public.onecab_internal_lost_property_cron_http_headers()
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO 'pg_catalog', 'vault'
  AS $fn$
  DECLARE
    v_count integer;
    v_tok text;
  BEGIN
    SELECT count(*)::integer INTO v_count
    FROM vault.decrypted_secrets ds
    WHERE ds.name = 'onecab_internal_lost_property_cron_token';
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'ONECAB_INTERNAL_LOST_PROPERTY_CRON_TOKEN_NOT_CONFIGURED' USING ERRCODE = 'P0001';
    END IF;
    SELECT nullif(btrim(ds.decrypted_secret), '') INTO v_tok
    FROM vault.decrypted_secrets ds
    WHERE ds.name = 'onecab_internal_lost_property_cron_token';
    IF v_tok IS NULL OR length(v_tok) < 32 THEN
      RAISE EXCEPTION 'ONECAB_INTERNAL_LOST_PROPERTY_CRON_TOKEN_INVALID' USING ERRCODE = 'P0001';
    END IF;
    RETURN jsonb_build_object(
      'Content-Type', 'application/json',
      'X-ONECAB-INTERNAL-LOST-PROPERTY-CRON-TOKEN', v_tok
    );
  END;
  $fn$;

  REVOKE ALL ON FUNCTION public.onecab_internal_lost_property_cron_http_headers() FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.onecab_internal_lost_property_cron_http_headers() FROM anon;
  REVOKE ALL ON FUNCTION public.onecab_internal_lost_property_cron_http_headers() FROM authenticated;
  REVOKE ALL ON FUNCTION public.onecab_internal_lost_property_cron_http_headers() FROM service_role;

  h := public.onecab_internal_lost_property_cron_http_headers();
  IF NOT (h ? 'Content-Type' AND h ? 'X-ONECAB-INTERNAL-LOST-PROPERTY-CRON-TOKEN')
     OR (h ? 'Authorization')
     OR length(h->>'X-ONECAB-INTERNAL-LOST-PROPERTY-CRON-TOKEN') < 32
  THEN
    RAISE EXCEPTION 'A8B27B SIM HARD STOP: header shape';
  END IF;

  IF has_function_privilege('anon', 'public.onecab_internal_lost_property_cron_http_headers()'::regprocedure, 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.onecab_internal_lost_property_cron_http_headers()'::regprocedure, 'EXECUTE')
     OR has_function_privilege('service_role', 'public.onecab_internal_lost_property_cron_http_headers()'::regprocedure, 'EXECUTE')
  THEN
    RAISE EXCEPTION 'A8B27B SIM HARD STOP: ACL';
  END IF;

  -- Transactional cron rewrite (rolled back); never invoke net.http_post
  PERFORM cron.alter_job(
    7,
    command := $cmd$
    SELECT net.http_post(
      url := 'https://thazislrdkjpvvghtvzo.supabase.co/functions/v1/lost-property?action=cleanup_photos',
      headers := public.onecab_internal_lost_property_cron_http_headers(),
      body := '{}'::jsonb
    ) AS request_id;
    $cmd$
  );
  PERFORM cron.alter_job(
    8,
    command := $cmd$
    SELECT net.http_post(
      url := 'https://thazislrdkjpvvghtvzo.supabase.co/functions/v1/lost-property?action=expire_chats',
      headers := public.onecab_internal_lost_property_cron_http_headers(),
      body := '{}'::jsonb
    ) AS request_id;
    $cmd$
  );

  IF EXISTS (
    SELECT 1 FROM cron.job
    WHERE jobid IN (7, 8)
      AND (command ILIKE '%Bearer%' OR command !~* 'onecab_internal_lost_property_cron_http_headers')
  ) THEN
    RAISE EXCEPTION 'A8B27B SIM HARD STOP: cron rewrite';
  END IF;

  SELECT count(*)::int INTO v_auth
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prosecdef
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_auth IS DISTINCT FROM 110 THEN
    RAISE EXCEPTION 'A8B27B SIM HARD STOP: auth_secdef=%', v_auth;
  END IF;

  RAISE NOTICE 'A8B27B_SIM_OK';
END $$;

ROLLBACK;
