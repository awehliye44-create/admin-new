-- ============================================================
-- ROLLBACK for 20261022120000_revolut_business_oauth_refresh_ownership.sql
--
-- Never deletes payment_provider_vault secret values.
-- Does NOT edit schema_migrations.
-- ============================================================

DROP FUNCTION IF EXISTS public.fail_revolut_business_oauth_refresh(uuid, text, text, text);
DROP FUNCTION IF EXISTS public.complete_revolut_business_oauth_refresh(uuid, bigint, text, timestamptz, text, text, text, text);
DROP FUNCTION IF EXISTS public.claim_revolut_business_oauth_refresh(text, text, integer, integer);

DROP POLICY IF EXISTS revolut_business_oauth_refresh_coord_deny_all
  ON public.revolut_business_oauth_refresh_coord;

DROP TABLE IF EXISTS public.revolut_business_oauth_refresh_coord;
