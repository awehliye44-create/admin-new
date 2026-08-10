DROP FUNCTION IF EXISTS public.get_my_last_trip_driver_details();
DROP FUNCTION IF EXISTS public.get_trip_driver_details(uuid);

CREATE OR REPLACE FUNCTION public.get_trip_driver_details(p_trip_id uuid)
RETURNS TABLE (
  trip_id uuid,
  trip_status text,
  driver_id uuid,
  driver_first_name text,
  driver_display_name text,
  driver_photo_path text,
  driver_rating numeric,
  driver_rating_count integer,
  vehicle_make text,
  vehicle_model text,
  vehicle_color text,
  vehicle_license_plate text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT
    t.id,
    t.status::text,
    d.id,
    d.first_name,
    TRIM(COALESCE(d.first_name, '') || ' ' || COALESCE(NULLIF(LEFT(COALESCE(d.last_name, ''), 1), ''), '')),
    regexp_replace(
      COALESCE(
        NULLIF(d.profile_photo_url, ''),
        (
          SELECT doc.file_url
          FROM documents doc
          WHERE doc.driver_id = d.id
            AND doc.document_type = 'profile_photo'
            AND doc.is_current IS TRUE
            AND doc.status = 'approved'
            AND COALESCE(doc.file_url, '') <> ''
          ORDER BY doc.created_at DESC
          LIMIT 1
        )
      ),
      '^.*/driver-documents/', ''
    ),
    COALESCE(d.display_rating, d.rating),
    d.rating_count,
    v.make,
    v.model,
    v.color,
    v.license_plate
  FROM trips t
  JOIN customers c ON c.id = t.passenger_id
  JOIN drivers d ON d.id = t.driver_id
  LEFT JOIN LATERAL (
    SELECT vh.make, vh.model, vh.color, vh.license_plate
    FROM vehicles vh
    WHERE vh.driver_id = d.id
    ORDER BY vh.created_at DESC
    LIMIT 1
  ) v ON true
  WHERE t.id = p_trip_id
    AND c.user_id = auth.uid();
$function$;

REVOKE ALL ON FUNCTION public.get_trip_driver_details(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_trip_driver_details(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_my_last_trip_driver_details()
RETURNS TABLE (
  trip_id uuid,
  trip_status text,
  driver_id uuid,
  driver_first_name text,
  driver_display_name text,
  driver_photo_path text,
  driver_rating numeric,
  driver_rating_count integer,
  vehicle_make text,
  vehicle_model text,
  vehicle_color text,
  vehicle_license_plate text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT g.*
  FROM (
    SELECT t.id
    FROM trips t
    JOIN customers c ON c.id = t.passenger_id
    WHERE c.user_id = auth.uid()
      AND t.driver_id IS NOT NULL
    ORDER BY COALESCE(t.completed_at, t.updated_at, t.created_at) DESC
    LIMIT 1
  ) last_trip
  CROSS JOIN LATERAL public.get_trip_driver_details(last_trip.id) g;
$function$;

REVOKE ALL ON FUNCTION public.get_my_last_trip_driver_details() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_last_trip_driver_details() TO authenticated;