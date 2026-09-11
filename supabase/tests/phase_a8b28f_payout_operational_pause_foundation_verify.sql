-- A8B28F Stage A post-apply verification (read-only; no PII)
-- Expect: column present; backfill=1; MK0006 pause=false; legacy eligibility MD5s unchanged.

SELECT
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='drivers'
      AND column_name='payout_operational_paused'
      AND is_nullable='NO'
      AND column_default ILIKE '%false%'
  ) AS op_col_ok,
  (SELECT count(*)::int FROM public.drivers WHERE payout_operational_paused IS TRUE) AS paused_count,
  (SELECT payout_operational_paused FROM public.drivers WHERE driver_code='MK0006') AS mk_paused,
  (SELECT coalesce(payouts_enabled,false) FROM public.drivers WHERE driver_code='MK0006') AS mk_legacy,
  (SELECT count(*)::int FROM public.driver_payout_destinations p
     JOIN public.drivers d ON d.id=p.driver_id
     WHERE d.driver_code='MK0006' AND p.is_active AND p.archived_at IS NULL
       AND upper(coalesce(p.provider_link_status,''))='FAILED') AS mk_failed_dest,
  (SELECT count(*)::int FROM public.driver_payout_destinations p
     JOIN public.drivers d ON d.id=p.driver_id
     WHERE d.driver_code='MK0006'
       AND (p.provider_counterparty_id IS NOT NULL OR p.verified_at IS NOT NULL)) AS mk_provider_evidence,
  md5((SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='driver_wallet_eligibility_balances'
         AND pg_get_function_identity_arguments(p.oid)='p_driver_id uuid')) AS elig_md5,
  md5((SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='get_driver_own_wallet_summary'
         AND pg_get_function_identity_arguments(p.oid)='p_service_area_id uuid')) AS summary_md5,
  EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='admin_set_driver_payout_operational_pause'
  ) AS admin_pause_rpc_absent_expected_false,
  to_regprocedure('public.driver_effective_payout_allowed(uuid)') IS NOT NULL AS effective_helper_present,
  to_regprocedure('public.driver_has_provider_verified_payout_destination(uuid)') IS NOT NULL AS provider_helper_present;
