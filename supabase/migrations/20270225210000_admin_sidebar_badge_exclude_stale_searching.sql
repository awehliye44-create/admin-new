-- Admin sidebar Active Trips badge must match filterAdminActiveTrips:
-- unassigned searching rows past searching_expires_at are not "open" rides.
-- Without this, a stuck searching trip (sweep revoked / delayed) inflates
-- admin_sidebar_badge_counts.activeTrips while the Active Trips board filters it out.

CREATE OR REPLACE FUNCTION public.admin_sidebar_badge_counts()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_active int := 0;
  v_scheduled int := 0;
  v_feedback int := 0;
  v_docs int := 0;
  v_promo int := 0;
  v_account int := 0;
  v_drivers int := 0;
  v_vehicle_changes int := 0;
  v_setting jsonb;
BEGIN
  -- Each badge requires the matching page grant (Owner passes via helper).
  IF public.staff_has_page_access('active-trips') THEN
    -- Mirror adminActiveBoardScheduledExclusivityOrFilter:
    -- instant (is_scheduled null/false) OR scheduled with a driver assigned.
    -- Mirror isAdminStaleSearchingTrip / filterAdminActiveTrips for searching.
    SELECT count(*) INTO v_active
    FROM public.trips t
    WHERE t.status = ANY (ARRAY[
      'searching','accepted','arriving','arrived','in_progress','started','on_trip','ongoing','trip_started'
    ])
      AND (
        t.is_scheduled IS NULL
        OR t.is_scheduled = false
        OR t.driver_id IS NOT NULL
      )
      AND NOT (
        t.status = 'searching'
        AND t.driver_id IS NULL
        AND t.searching_expires_at IS NOT NULL
        AND t.searching_expires_at < now()
      );
  END IF;

  IF public.staff_has_page_access('scheduled-rides') THEN
    SELECT count(*) INTO v_scheduled
    FROM public.trips t
    WHERE t.is_scheduled = true
      AND t.driver_id IS NULL
      AND t.status NOT IN ('completed','cancelled','no_show','expired')
      AND (t.scheduled_status IS NULL OR t.scheduled_status NOT IN ('cancelled','expired','no_driver_found'));
  END IF;

  IF public.staff_has_page_access('rider-feedback') THEN
    SELECT count(*) INTO v_feedback
    FROM public.rider_feedback rf
    WHERE rf.status = ANY (ARRAY['pending','new']);
  END IF;

  IF public.staff_has_page_access('documents') OR public.staff_has_page_access('document-management') THEN
    SELECT count(*) INTO v_docs
    FROM public.documents d
    JOIN public.drivers dr ON dr.id = d.driver_id
    WHERE d.status = 'pending' AND d.is_current = true AND dr.deleted_at IS NULL;
  END IF;

  IF public.staff_has_page_access('promo-codes') THEN
    SELECT count(*) INTO v_promo
    FROM public.promo_codes pc
    WHERE pc.is_active = true
      AND (pc.valid_until IS NULL OR pc.valid_until >= now());
  END IF;

  IF public.staff_has_page_access('account-requests') THEN
    SELECT setting_value INTO v_setting
    FROM public.admin_settings
    WHERE setting_key = 'account_requests'
    LIMIT 1;
    IF v_setting IS NOT NULL AND jsonb_typeof(v_setting) = 'array' THEN
      SELECT count(*) INTO v_account
      FROM jsonb_array_elements(v_setting) e
      WHERE e.value->>'status' = 'pending';
    END IF;
  END IF;

  IF public.staff_has_page_access('drivers') THEN
    SELECT count(*) INTO v_drivers
    FROM public.drivers d
    WHERE d.approval_status = 'pending' AND d.deleted_at IS NULL;
  END IF;

  IF public.staff_has_page_access('vehicles') OR public.staff_has_page_access('drivers') THEN
    SELECT count(*) INTO v_vehicle_changes
    FROM public.vehicle_change_requests vcr
    JOIN public.drivers dr ON dr.id = vcr.driver_id
    WHERE vcr.status = 'pending' AND dr.deleted_at IS NULL;
  END IF;

  RETURN jsonb_build_object(
    'activeTrips', v_active,
    'scheduledRides', v_scheduled,
    'pendingFeedback', v_feedback,
    'pendingDocuments', v_docs,
    'activePromoCodes', v_promo,
    'pendingAccountRequests', v_account,
    'pendingDrivers', v_drivers,
    'pendingVehicleChanges', v_vehicle_changes
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.admin_sidebar_badge_counts() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_sidebar_badge_counts() FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_sidebar_badge_counts() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_sidebar_badge_counts() TO service_role;
