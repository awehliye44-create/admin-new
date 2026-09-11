-- ============================================================
-- Phase A8B27B: lost-property cron internal auth Vault bridge
-- Applied to ACTIVE_HEALTHY (Stage 1 SQL bridge only; Edge gate not deployed).
--
-- Prerequisites (manual, before apply):
--   1) Create Vault secret name exactly:
--        onecab_internal_lost_property_cron_token
--      value: strong random >= 32 chars (same value as Edge secret)
--   2) Set Edge Function secret on lost-property:
--        ONECAB_INTERNAL_LOST_PROPERTY_CRON_TOKEN
--      to the SAME value (do not print)
--
-- This migration:
--   - Adds postgres-only helper onecab_internal_lost_property_cron_http_headers()
--   - Rewrites cron jobs 7/8 to send only Content-Type + dedicated X-ONECAB header
--   - Removes embedded Authorization Bearer from those cron commands
--
-- Does NOT:
--   - Create/rotate the Vault secret
--   - Deploy Edge
--   - Change cleanup/expire business logic or A8B27 Admin gate
--
-- Expected Advisor impact: none (no new authenticated SECDEF EXECUTE)
-- ============================================================

BEGIN;

DO $$
DECLARE
  v_latest text;
  v_count int;
BEGIN
  SELECT version INTO v_latest
  FROM supabase_migrations.schema_migrations
  ORDER BY version DESC
  LIMIT 1;
  IF v_latest IS DISTINCT FROM '20261109400000' THEN
    RAISE EXCEPTION 'A8B27B HARD STOP: unexpected latest migration %', v_latest;
  END IF;
  IF EXISTS (
    SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261109410000'
  ) THEN
    RAISE EXCEPTION 'A8B27B HARD STOP: migration already recorded';
  END IF;

  IF to_regclass('vault.decrypted_secrets') IS NULL THEN
    RAISE EXCEPTION 'A8B27B HARD STOP: vault.decrypted_secrets unavailable';
  END IF;

  SELECT count(*)::int INTO v_count
  FROM vault.decrypted_secrets ds
  WHERE ds.name = 'onecab_internal_lost_property_cron_token';
  IF v_count = 0 THEN
    RAISE EXCEPTION 'A8B27B HARD STOP: provision Vault secret onecab_internal_lost_property_cron_token first';
  ELSIF v_count > 1 THEN
    RAISE EXCEPTION 'A8B27B HARD STOP: duplicate Vault secret name';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobid = 7 AND jobname = 'lost-property-photo-cleanup' AND active) THEN
    RAISE EXCEPTION 'A8B27B HARD STOP: cron job 7 missing/inactive';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobid = 8 AND jobname = 'lost-property-expire-chats' AND active) THEN
    RAISE EXCEPTION 'A8B27B HARD STOP: cron job 8 missing/inactive';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.onecab_internal_lost_property_cron_http_headers()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'vault'
AS $fn$
DECLARE
  v_count integer;
  v_token text;
BEGIN
  SELECT count(*)::integer INTO v_count
  FROM vault.decrypted_secrets ds
  WHERE ds.name = 'onecab_internal_lost_property_cron_token';

  IF v_count = 0 THEN
    RAISE EXCEPTION 'ONECAB_INTERNAL_LOST_PROPERTY_CRON_TOKEN_NOT_CONFIGURED'
      USING ERRCODE = 'P0001';
  ELSIF v_count > 1 THEN
    RAISE EXCEPTION 'ONECAB_INTERNAL_LOST_PROPERTY_CRON_TOKEN_DUPLICATE'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT nullif(btrim(ds.decrypted_secret), '') INTO v_token
  FROM vault.decrypted_secrets ds
  WHERE ds.name = 'onecab_internal_lost_property_cron_token';

  IF v_token IS NULL OR length(v_token) < 32 THEN
    RAISE EXCEPTION 'ONECAB_INTERNAL_LOST_PROPERTY_CRON_TOKEN_INVALID'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object(
    'Content-Type', 'application/json',
    'X-ONECAB-INTERNAL-LOST-PROPERTY-CRON-TOKEN', v_token
  );
END;
$fn$;

COMMENT ON FUNCTION public.onecab_internal_lost_property_cron_http_headers() IS
  'A8B27B: pg_net headers for lost-property cron actions. Postgres-only. Reads Vault secret onecab_internal_lost_property_cron_token. Never embeds Bearer/anon/service_role.';

REVOKE ALL ON FUNCTION public.onecab_internal_lost_property_cron_http_headers() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.onecab_internal_lost_property_cron_http_headers() FROM anon;
REVOKE ALL ON FUNCTION public.onecab_internal_lost_property_cron_http_headers() FROM authenticated;
REVOKE ALL ON FUNCTION public.onecab_internal_lost_property_cron_http_headers() FROM service_role;
-- postgres retains EXECUTE as owner

DO $$
DECLARE
  h jsonb;
BEGIN
  h := public.onecab_internal_lost_property_cron_http_headers();
  IF jsonb_typeof(h) IS DISTINCT FROM 'object'
     OR NOT (h ? 'Content-Type')
     OR NOT (h ? 'X-ONECAB-INTERNAL-LOST-PROPERTY-CRON-TOKEN')
     OR (h->>'Content-Type') IS DISTINCT FROM 'application/json'
     OR length(h->>'X-ONECAB-INTERNAL-LOST-PROPERTY-CRON-TOKEN') < 32
     OR (h ? 'Authorization')
  THEN
    RAISE EXCEPTION 'A8B27B HARD STOP: helper header shape invalid';
  END IF;

  IF has_function_privilege('anon', 'public.onecab_internal_lost_property_cron_http_headers()'::regprocedure, 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.onecab_internal_lost_property_cron_http_headers()'::regprocedure, 'EXECUTE')
     OR has_function_privilege('service_role', 'public.onecab_internal_lost_property_cron_http_headers()'::regprocedure, 'EXECUTE')
     OR has_function_privilege('public', 'public.onecab_internal_lost_property_cron_http_headers()'::regprocedure, 'EXECUTE')
  THEN
    RAISE EXCEPTION 'A8B27B HARD STOP: helper ACL too open';
  END IF;
END $$;

-- Rewrite cron callers: no embedded Bearer; headers from postgres-only helper.
SELECT cron.alter_job(
  7,
  command := $cmd$
  SELECT net.http_post(
    url := 'https://thazislrdkjpvvghtvzo.supabase.co/functions/v1/lost-property?action=cleanup_photos',
    headers := public.onecab_internal_lost_property_cron_http_headers(),
    body := '{}'::jsonb
  ) AS request_id;
  $cmd$
);

SELECT cron.alter_job(
  8,
  command := $cmd$
  SELECT net.http_post(
    url := 'https://thazislrdkjpvvghtvzo.supabase.co/functions/v1/lost-property?action=expire_chats',
    headers := public.onecab_internal_lost_property_cron_http_headers(),
    body := '{}'::jsonb
  ) AS request_id;
  $cmd$
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM cron.job
    WHERE jobid IN (7, 8)
      AND (command ILIKE '%Bearer%' OR command !~* 'onecab_internal_lost_property_cron_http_headers')
  ) THEN
    RAISE EXCEPTION 'A8B27B HARD STOP: cron commands not rewritten safely';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM cron.job WHERE jobid = 7 AND active AND schedule = '0 4 * * *'
  ) OR NOT EXISTS (
    SELECT 1 FROM cron.job WHERE jobid = 8 AND active AND schedule = '*/15 * * * *'
  ) THEN
    RAISE EXCEPTION 'A8B27B HARD STOP: cron schedule/active drift';
  END IF;
END $$;

COMMIT;
