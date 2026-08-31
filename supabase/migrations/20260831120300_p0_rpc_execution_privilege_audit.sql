-- P0: Targeted RPC EXECUTE privilege hardening (audited, not blanket).
-- Preserves pre-auth onboarding allowlist; revokes anon from admin/finance/trigger RPCs.
-- Rollback (manual only, NOT a migration): supabase/rollback/p0_security_hardening_rollback_20260831.sql

-- ---------------------------------------------------------------------------
-- 1) Anon allowlist — genuinely pre-auth client RPCs only
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
  allowlist text[] := ARRAY[
    'list_driver_signup_countries',
    'get_driver_signup_location_options',
    'get_driver_signup_service_areas',
    'validate_driver_signup_region_service_areas',
    'list_enabled_otp_country_codes'
  ];
BEGIN
  FOR r IN
    SELECT p.oid, p.oid::regprocedure::text AS sig, p.proname
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef
      AND has_function_privilege('anon', p.oid, 'EXECUTE')
      AND NOT (p.proname = ANY (allowlist))
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', r.sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', r.sig);
    IF has_function_privilege('authenticated', r.oid, 'EXECUTE') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', r.sig);
    END IF;
    IF has_function_privilege('service_role', r.oid, 'EXECUTE') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.sig);
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 2) Explicit admin/finance RPC — authenticated (+ service_role), never anon
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  fn text;
  sig text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'admin_driver_financial_summaries(uuid, uuid)',
    'admin_driver_wallet_eligibility_balances(uuid[])'
  ]
  LOOP
    sig := 'public.' || fn;
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', sig);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 3) Trigger / internal SECURITY DEFINER — not client-callable RPCs
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
  internal_names text[] := ARRAY[
    'enforce_commission_wallet_ledger_financial_model',
    'enforce_payment_session_financial_model',
    'enforce_payout_item_financial_model',
    'enforce_trip_financial_model_immutable',
    'persist_pickup_waiting_admin_ssot',
    'prevent_platform_wallet_ledger_on_cw_trip',
    'protect_owner_staff_profile',
    'refresh_driver_document_approval_flags',
    'stamp_trip_financial_model_on_insert',
    'trg_commission_wallet_on_trip_complete',
    'trg_commission_wallet_release_on_cancel',
    'trg_payout_item_ledger_allocations_validate',
    'trg_payout_item_require_lineage_before_execute',
    'trg_scheduled_handover_block_premature_search_ttl',
    'trg_trip_invoice_on_completion',
    'assert_payout_item_ledger_lineage',
    'insert_payout_ledger_debit_if_missing',
    'schedule_dispatch_sweep',
    'scheduled_dispatch_sweep'
  ];
BEGIN
  FOR r IN
    SELECT p.oid, p.oid::regprocedure::text AS sig, p.proname
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = ANY (internal_names)
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', r.sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', r.sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.sig);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 4) Authenticated app RPCs wrongly granted to anon — keep authenticated path
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
  auth_only text[] := ARRAY[
    'finalize_driver_onboarding_registration',
    'customer_counter_ride_offer',
    'driver_send_preset_offer',
    'driver_wallet_eligibility_balances',
    'driver_wallet_payout_clearing_delay_hours',
    'get_driver_document_compliance',
    'passenger_has_live_immediate_trip',
    'payment_authorisation_valid'
  ];
BEGIN
  FOR r IN
    SELECT p.oid, p.oid::regprocedure::text AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = ANY (auth_only)
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', r.sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.sig);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 5) Backend-only tables with RLS + zero policies — document + revoke clients
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'historical_settlement_correction_audit',
    'onecab_assistant_config',
    'onecab_assistant_events',
    'onecab_assistant_rate_limits',
    'whatsapp_conversations',
    'whatsapp_inbound_messages'
  ]
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM authenticated', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', t);
    EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', t);
  END LOOP;
END $$;

COMMENT ON TABLE public.onecab_assistant_config IS
  'Backend-only (RLS enabled, zero client policies). Access via service_role / Edge Functions only.';
COMMENT ON TABLE public.whatsapp_conversations IS
  'Backend-only (RLS enabled, zero client policies). Access via service_role / WhatsApp Edge Functions only.';
