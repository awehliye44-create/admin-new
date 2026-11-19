-- 1) Pin search_path on the 25 flagged functions (keeps today's lookup order: public, then extensions).
DO $sp$
DECLARE r record;
BEGIN
  FOR r IN SELECT p.oid::regprocedure sig FROM pg_proc p
    WHERE p.pronamespace='public'::regnamespace AND p.prokind='f'
      AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig,'{}')) c WHERE c LIKE 'search_path=%')
      AND p.proname IN ('_admin_page_col_expr','_admin_page_columns','_admin_page_mutate_columns','_admin_page_mutate_pages','_admin_page_table_allowed','_admin_service_areas_lookup_page_allowed','_on_active','_on_sched','driver_realtime_delivery_fresh','sync_trip_stop_count','trip_schedule_estimated_end','resolve_fleet_max_pickup_distance_meters','payment_sessions_preserve_capture_deadline','evaluate_scheduled_advance_window','assert_scheduled_advance_window','required_capture_coverage_until','trips_enforce_scheduled_advance_window','trips_enforce_payment_first_platform_card','trips_enforce_scheduled_modification_coverage','_admin_trips_protected_mutate_columns','is_driver_active_trip_snapshot_status','driver_active_trip_snapshot_lifecycle_rank','is_driver_active_trip_snapshot_scheduled_activated','is_driver_active_trip_snapshot_unactivated_scheduled','driver_trip_bonus_campaign_windows_overlap')
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = public, extensions', r.sig);
  END LOOP;
END
$sp$;

-- 2) Signed-in callers of record_driver_location_publish_diag with origin 'rpc'
--    can only attribute diagnostics to themselves; a claimed other driver id is kept in metadata.
DO $diag$
DECLARE
  d text := pg_get_functiondef('public.record_driver_location_publish_diag'::regproc);
  pat text := 'END IF;(\s*)-- origin=rpc typically via SECURITY DEFINER nested call \(no auth\.uid check needed\)';
  rep text := 'ELSIF v_origin = ''rpc'' THEN
      -- Signed-in callers may only attribute rows to themselves.
      v_driver_id := public.current_driver_id();
      IF p_driver_id IS NOT NULL AND p_driver_id IS DISTINCT FROM v_driver_id THEN
        p_metadata := COALESCE(p_metadata, ''{}''::jsonb) || jsonb_build_object(''claimed_driver_id'', p_driver_id);
      END IF;
    END IF;\1-- origin=rpc without a signed-in caller = backend (service role)';
BEGIN
  IF d !~ pat THEN
    RAISE EXCEPTION 'record_driver_location_publish_diag layout changed; not patched';
  END IF;
  EXECUTE regexp_replace(d, pat, rep);
END
$diag$;

-- 3) Backend-only helpers: no direct use by signed-in app users.
--    find_nearby_drivers returns exact positions of every online driver for any radius
--    (riders use passenger_map_nearby_drivers, which caps the radius);
--    force_driver_offline_for_document_ineligibility can switch any driver offline.
REVOKE EXECUTE ON FUNCTION public.find_nearby_drivers(double precision, double precision, double precision, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.find_nearby_drivers(double precision, double precision, double precision, integer, integer) TO service_role;
REVOKE EXECUTE ON FUNCTION public.force_driver_offline_for_document_ineligibility(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.force_driver_offline_for_document_ineligibility(uuid) TO service_role;