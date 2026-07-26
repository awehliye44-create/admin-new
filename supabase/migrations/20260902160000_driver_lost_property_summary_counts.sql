-- Driver Lost Property summary counts (privacy-safe, own driver_found only).
-- Fixes overview cards counting only the current page of list_driver_own_lost_property_reports.

CREATE OR REPLACE FUNCTION public.get_driver_own_lost_property_summary_counts()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_driver_id uuid := public.current_driver_id();
  v_open int := 0;
  v_returned int := 0;
  v_archived int := 0;
  v_cancelled int := 0;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;
  IF v_driver_id IS NULL THEN
    RETURN jsonb_build_object(
      'open', 0,
      'returned', 0,
      'archived', 0,
      'cancelled', 0
    );
  END IF;

  SELECT
    COUNT(*) FILTER (
      WHERE public.driver_lost_property_display_status(c.status, c.collected_at) IN (
        'open', 'under_review', 'awaiting_collection'
      )
    )::int,
    COUNT(*) FILTER (
      WHERE public.driver_lost_property_display_status(c.status, c.collected_at) = 'returned'
    )::int,
    COUNT(*) FILTER (
      WHERE public.driver_lost_property_display_status(c.status, c.collected_at) = 'archived'
    )::int,
    COUNT(*) FILTER (
      WHERE public.driver_lost_property_display_status(c.status, c.collected_at) = 'cancelled'
    )::int
  INTO v_open, v_returned, v_archived, v_cancelled
  FROM public.lost_property_cases c
  WHERE c.driver_id = v_driver_id
    AND c.case_origin = 'driver_found';

  RETURN jsonb_build_object(
    'open', COALESCE(v_open, 0),
    'returned', COALESCE(v_returned, 0),
    'archived', COALESCE(v_archived, 0),
    'cancelled', COALESCE(v_cancelled, 0)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_driver_own_lost_property_summary_counts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_driver_own_lost_property_summary_counts() TO authenticated;
