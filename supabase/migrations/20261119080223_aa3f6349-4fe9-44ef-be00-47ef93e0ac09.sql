DO $mig$
DECLARE
  r record;
  backend_only text[] := ARRAY[
    -- trip / fare / scheduling writers used only by backend + other definer steps
    'apply_consumed_server_fare_airport_split_to_trip','claim_and_apply_fare_increase_modification',
    'realign_trip_nav_after_modification','claim_corporate_schedule_hold',
    'release_scheduled_assignment_for_compliance','release_scheduled_assignment_for_driver_cancel',
    'release_ineligible_scheduled_assignments_for_driver','release_scheduled_airport_broadcast_hold',
    'reconcile_scheduled_journey_compliance','classify_scheduled_capture_deadline_backfill',
    'normalise_payment_gate_blocked_terminal_rows','purge_driver_location_publish_diagnostics',
    -- read helpers that leak driver/trip facts
    'check_driver_documents_valid_through','driver_has_completed_registration_verification',
    'driver_eligible_for_scheduled_journey','assert_driver_scheduled_journey_compliance',
    'evaluate_trip_schedule_conflict','trip_has_unresolved_fare_increase_modification',
    'assert_trip_completion_customer_payment_gate','resolve_scheduled_overlap_buffer_minutes',
    -- trigger-only functions (firing does not check EXECUTE)
    'deny_client_driver_financial_repair_mutate','deny_customer_receivable_event_mutation',
    'deny_direct_customer_receivable_mutation','deny_direct_driver_payout_pause_write',
    'deny_direct_receivable_allocation_mutation','deny_driver_financial_repair_audit_mutation',
    'deny_finance_shortfall_exception_delete','enforce_trip_change_payment_before_apply',
    'freeze_finance_shortfall_exception_evidence','release_scheduled_on_driver_account_change',
    'require_customer_receivable_write_guc','require_finance_shortfall_exception_write_guc',
    'seed_service_area_rules_for_document_type','tr_restamp_pending_offers_on_airport_stamp_fn',
    'tr_trip_messages_reject_blocked_pair','trg_enqueue_driver_trip_bonus_progress',
    'trips_enforce_customer_schedule_overlap'
  ];
  signed_in_only text[] := ARRAY[
    -- app/staff callers; each already checks the signed-in caller
    'submit_driver_location_sample','record_driver_location_publish_diag',
    'admin_assign_scheduled_driver','admin_submit_driver_document','admin_driver_financial_repair_lock',
    'get_customer_live_for_driver','get_driver_own_online_duration_seconds',
    'touch_driver_offer_realtime_seen','upsert_customer_live_location'
  ];
BEGIN
  FOR r IN SELECT p.oid::regprocedure AS sig FROM pg_proc p
           WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY(backend_only) LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.sig);
  END LOOP;
  FOR r IN SELECT p.oid::regprocedure AS sig FROM pg_proc p
           WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY(signed_in_only) LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', r.sig);
  END LOOP;
END
$mig$;