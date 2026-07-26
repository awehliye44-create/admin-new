-- Driver-initiated Lost Property (found item) — Gap close for Driver app template.
-- Reuses lost_property_cases + lost-property-photos. Does not replace customer_lost flow.
--
-- Policy:
-- - Eligible trips: status = completed only (same as existing create_case). No-shows NOT eligible.
-- - Usage: driver creates report for own completed trip; cancel only while OPEN + case_origin=driver_found.
-- - Privacy: Driver RPCs never return customer PII, addresses, or coordinates.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.list_driver_own_lost_property_reports(integer, timestamptz);
--   DROP FUNCTION IF EXISTS public.get_driver_own_lost_property_report(uuid);
--   DROP FUNCTION IF EXISTS public.list_driver_own_lost_property_eligible_trips(integer);
--   DROP FUNCTION IF EXISTS public.cancel_driver_own_lost_property_report(uuid);
--   -- columns left in place (nullable) unless explicitly dropped after clients rolled back.

ALTER TABLE public.lost_property_cases
  ADD COLUMN IF NOT EXISTS case_origin text NOT NULL DEFAULT 'customer_lost',
  ADD COLUMN IF NOT EXISTS item_name text,
  ADD COLUMN IF NOT EXISTS item_colour text,
  ADD COLUMN IF NOT EXISTS item_brand text,
  ADD COLUMN IF NOT EXISTS found_location text,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'lost_property_cases_case_origin_check'
  ) THEN
    ALTER TABLE public.lost_property_cases
      ADD CONSTRAINT lost_property_cases_case_origin_check
      CHECK (case_origin IN ('customer_lost', 'driver_found'));
  END IF;
END $$;

COMMENT ON COLUMN public.lost_property_cases.case_origin IS
  'customer_lost = customer reported missing item; driver_found = driver reported found item after trip';
COMMENT ON COLUMN public.lost_property_cases.item_name IS
  'Short item title for driver_found reports (and optional display for customer_lost)';

-- Allow OPEN / CANCELLED for driver_found without breaking existing statuses (text column, no enum).

CREATE OR REPLACE FUNCTION public.driver_lost_property_public_trip_ref(p_trip_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(t.trip_number, t.trip_code, NULL)
  FROM public.trips t
  WHERE t.id = p_trip_id;
$function$;

REVOKE ALL ON FUNCTION public.driver_lost_property_public_trip_ref(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.driver_lost_property_public_trip_ref(uuid) TO authenticated, service_role;

-- Display status for Driver UI (never raw-only)
CREATE OR REPLACE FUNCTION public.driver_lost_property_display_status(p_status text, p_collected_at timestamptz)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN upper(trim(COALESCE(p_status, ''))) = 'CANCELLED' THEN 'cancelled'
    WHEN upper(trim(COALESCE(p_status, ''))) = 'CLOSED' AND p_collected_at IS NOT NULL THEN 'returned'
    WHEN upper(trim(COALESCE(p_status, ''))) = 'CLOSED' THEN 'archived'
    WHEN upper(trim(COALESCE(p_status, ''))) IN (
      'AWAITING_COLLECTION', 'RETURN_RIDE_REQUESTED', 'RETURN_RIDE_BOOKED'
    ) THEN 'awaiting_collection'
    WHEN upper(trim(COALESCE(p_status, ''))) IN (
      'AWAITING_CUSTOMER_CONFIRMATION', 'AWAITING_RETURN_METHOD', 'ESCALATED', 'SENT_TO_DRIVER'
    ) THEN 'under_review'
    WHEN upper(trim(COALESCE(p_status, ''))) = 'OPEN' THEN 'open'
    ELSE 'open'
  END;
$function$;

-- Eligible completed trips for driver_found reports
CREATE OR REPLACE FUNCTION public.list_driver_own_lost_property_eligible_trips(
  p_limit integer DEFAULT 50
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_driver_id uuid := public.current_driver_id();
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;
  IF v_driver_id IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;

  RETURN COALESCE(
    (
      SELECT jsonb_agg(to_jsonb(row) ORDER BY row.completed_at DESC NULLS LAST)
      FROM (
        SELECT
          t.id AS trip_id,
          COALESCE(t.trip_number, t.trip_code) AS public_trip_ref,
          COALESCE(t.completed_at, t.updated_at) AS completed_at
        FROM public.trips t
        WHERE t.status = 'completed'
          AND (
            t.confirmed_driver_id = v_driver_id
            OR (t.confirmed_driver_id IS NULL AND t.driver_id = v_driver_id)
          )
          AND COALESCE(t.trip_number, t.trip_code) IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM public.lost_property_cases c
            WHERE c.trip_id = t.id
              AND c.case_origin = 'driver_found'
              AND c.driver_id = v_driver_id
              AND upper(c.status) NOT IN ('CANCELLED', 'CLOSED')
          )
        ORDER BY COALESCE(t.completed_at, t.updated_at) DESC NULLS LAST
        LIMIT v_limit
      ) row
    ),
    '[]'::jsonb
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.list_driver_own_lost_property_eligible_trips(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_driver_own_lost_property_eligible_trips(integer) TO authenticated;

-- List driver's own reports (privacy-safe)
CREATE OR REPLACE FUNCTION public.list_driver_own_lost_property_reports(
  p_limit integer DEFAULT 50,
  p_before timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_driver_id uuid := public.current_driver_id();
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;
  IF v_driver_id IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;

  RETURN COALESCE(
    (
      SELECT jsonb_agg(to_jsonb(row) ORDER BY row.reported_at DESC)
      FROM (
        SELECT
          c.id AS report_id,
          c.case_number AS public_reference,
          public.driver_lost_property_public_trip_ref(c.trip_id) AS public_trip_ref,
          COALESCE(NULLIF(trim(c.item_name), ''), left(c.item_description, 80)) AS item_name,
          c.item_category AS category,
          public.driver_lost_property_display_status(c.status, c.collected_at) AS display_status,
          c.status AS backend_status,
          c.created_at AS reported_at,
          CASE
            WHEN c.found_item_photos IS NOT NULL AND cardinality(c.found_item_photos) > 0
              THEN c.found_item_photos[1]
            WHEN c.driver_photos IS NOT NULL AND cardinality(c.driver_photos) > 0
              THEN c.driver_photos[1]
            WHEN c.photos IS NOT NULL AND cardinality(c.photos) > 0
              THEN c.photos[1]
            ELSE NULL
          END AS thumbnail_path,
          (public.driver_lost_property_display_status(c.status, c.collected_at) = 'open'
            AND c.case_origin = 'driver_found') AS can_cancel
        FROM public.lost_property_cases c
        WHERE c.driver_id = v_driver_id
          AND c.case_origin = 'driver_found'
          AND (p_before IS NULL OR c.created_at < p_before)
        ORDER BY c.created_at DESC
        LIMIT v_limit
      ) row
    ),
    '[]'::jsonb
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.list_driver_own_lost_property_reports(integer, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_driver_own_lost_property_reports(integer, timestamptz) TO authenticated;

-- Details (privacy-safe)
CREATE OR REPLACE FUNCTION public.get_driver_own_lost_property_report(p_report_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_driver_id uuid := public.current_driver_id();
  v_row record;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;
  IF v_driver_id IS NULL OR p_report_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  SELECT
    c.*,
    public.driver_lost_property_public_trip_ref(c.trip_id) AS public_trip_ref,
    t.completed_at AS trip_completed_at
  INTO v_row
  FROM public.lost_property_cases c
  LEFT JOIN public.trips t ON t.id = c.trip_id
  WHERE c.id = p_report_id
    AND c.driver_id = v_driver_id
    AND c.case_origin = 'driver_found';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'report', jsonb_build_object(
      'report_id', v_row.id,
      'public_reference', v_row.case_number,
      'public_trip_ref', v_row.public_trip_ref,
      'trip_completed_at', v_row.trip_completed_at,
      'item_name', COALESCE(NULLIF(trim(v_row.item_name), ''), left(v_row.item_description, 80)),
      'category', v_row.item_category,
      'description', v_row.item_description,
      'colour', v_row.item_colour,
      'brand', v_row.item_brand,
      'found_location', v_row.found_location,
      'display_status', public.driver_lost_property_display_status(v_row.status, v_row.collected_at),
      'backend_status', v_row.status,
      'reported_at', v_row.created_at,
      'photo_paths', COALESCE(
        NULLIF(v_row.found_item_photos, ARRAY[]::text[]),
        NULLIF(v_row.driver_photos, ARRAY[]::text[]),
        NULLIF(v_row.photos, ARRAY[]::text[]),
        ARRAY[]::text[]
      ),
      'can_cancel', (
        public.driver_lost_property_display_status(v_row.status, v_row.collected_at) = 'open'
        AND v_row.case_origin = 'driver_found'
      ),
      'can_contact_support', true
    )
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_driver_own_lost_property_report(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_driver_own_lost_property_report(uuid) TO authenticated;

-- Cancel open driver_found report
CREATE OR REPLACE FUNCTION public.cancel_driver_own_lost_property_report(p_report_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_driver_id uuid := public.current_driver_id();
  v_case public.lost_property_cases%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;
  IF v_driver_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_driver');
  END IF;

  SELECT * INTO v_case
  FROM public.lost_property_cases
  WHERE id = p_report_id
  FOR UPDATE;

  IF NOT FOUND OR v_case.driver_id IS DISTINCT FROM v_driver_id OR v_case.case_origin IS DISTINCT FROM 'driver_found' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  IF public.driver_lost_property_display_status(v_case.status, v_case.collected_at) <> 'open' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_cancellable', 'backend_status', v_case.status);
  END IF;

  UPDATE public.lost_property_cases
  SET status = 'CANCELLED',
      cancelled_at = now(),
      updated_at = now(),
      chat_enabled = false,
      chat_locked_at = COALESCE(chat_locked_at, now()),
      chat_lock_reason = COALESCE(chat_lock_reason, 'driver_cancelled')
  WHERE id = p_report_id;

  RETURN jsonb_build_object('ok', true, 'report_id', p_report_id, 'display_status', 'cancelled');
END;
$function$;

REVOKE ALL ON FUNCTION public.cancel_driver_own_lost_property_report(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cancel_driver_own_lost_property_report(uuid) TO authenticated;
