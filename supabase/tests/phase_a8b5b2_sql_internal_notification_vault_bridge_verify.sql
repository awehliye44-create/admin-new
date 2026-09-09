-- Phase A8B5B2-SQL catalog verification (local/scratch or linked BEGIN/ROLLBACK).
-- May CREATE/REPLACE inside BEGIN and MUST ROLLBACK.
-- Does not invoke notification functions, update trips/offers, or call net.http_post.
-- Uses synthetic Vault secret only inside the transaction — never print secret values.
-- Prefer the linked simulation already exercised in Phase A8B5B2 revise.

BEGIN;

DO $boot$
BEGIN
  IF exists(SELECT 1 FROM vault.secrets WHERE name = 'onecab_internal_notification_token') THEN
    RAISE EXCEPTION 'verify aborted: intended Vault secret already present';
  END IF;
END;
$boot$;

DO $seed$
BEGIN
  PERFORM vault.create_secret(
    encode(gen_random_bytes(32), 'hex'),
    'onecab_internal_notification_token',
    'A8B5B2 verify synthetic — must not persist'
  );
END;
$seed$;

-- Apply helper ACL checks only (full caller rewrite covered by linked sim).
CREATE OR REPLACE FUNCTION public.onecab_internal_notification_http_headers()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, vault
AS $fn$
DECLARE
  v_count integer;
  v_token text;
BEGIN
  SELECT count(*)::integer INTO v_count
  FROM vault.decrypted_secrets ds
  WHERE ds.name = 'onecab_internal_notification_token';
  IF v_count = 0 THEN
    RAISE EXCEPTION 'ONECAB_INTERNAL_NOTIFICATION_TOKEN_NOT_CONFIGURED' USING ERRCODE = 'P0001';
  ELSIF v_count > 1 THEN
    RAISE EXCEPTION 'ONECAB_INTERNAL_NOTIFICATION_TOKEN_DUPLICATE' USING ERRCODE = 'P0001';
  END IF;
  SELECT nullif(btrim(ds.decrypted_secret), '') INTO v_token
  FROM vault.decrypted_secrets ds
  WHERE ds.name = 'onecab_internal_notification_token';
  IF v_token IS NULL OR length(v_token) < 32 THEN
    RAISE EXCEPTION 'ONECAB_INTERNAL_NOTIFICATION_TOKEN_INVALID' USING ERRCODE = 'P0001';
  END IF;
  RETURN jsonb_build_object(
    'Content-Type', 'application/json',
    'X-ONECAB-INTERNAL-NOTIFICATION-TOKEN', v_token
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.onecab_internal_notification_http_headers() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.onecab_internal_notification_http_headers() FROM anon;
REVOKE ALL ON FUNCTION public.onecab_internal_notification_http_headers() FROM authenticated;
REVOKE ALL ON FUNCTION public.onecab_internal_notification_http_headers() FROM service_role;

DO $acl$
DECLARE
  h jsonb;
BEGIN
  IF has_function_privilege('anon', 'public.onecab_internal_notification_http_headers()'::regprocedure, 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.onecab_internal_notification_http_headers()'::regprocedure, 'EXECUTE')
     OR has_function_privilege('service_role', 'public.onecab_internal_notification_http_headers()'::regprocedure, 'EXECUTE')
     OR has_function_privilege('public', 'public.onecab_internal_notification_http_headers()'::regprocedure, 'EXECUTE')
  THEN
    RAISE EXCEPTION 'helper EXECUTE leaked to API role';
  END IF;
  h := public.onecab_internal_notification_http_headers();
  IF NOT (h ? 'Content-Type' AND h ? 'X-ONECAB-INTERNAL-NOTIFICATION-TOKEN')
     OR length(h->>'X-ONECAB-INTERNAL-NOTIFICATION-TOKEN') < 32
  THEN
    RAISE EXCEPTION 'helper shape invalid';
  END IF;
END;
$acl$;

ROLLBACK;
