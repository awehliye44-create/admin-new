-- passenger_ratings.passenger_id is often NULL (writers only set trip_id).
-- get_customer_trip_stats previously filtered on passenger_id alone → avg_rating
-- always null even when drivers rated the passenger on completed trips.
-- Resolve passenger via COALESCE(rating.passenger_id, trips.passenger_id).

CREATE OR REPLACE FUNCTION public.get_customer_trip_stats(_passenger_id uuid)
 RETURNS TABLE(total_trips integer, avg_rating numeric, rating_count integer)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    (SELECT COUNT(*)::int
       FROM public.trips
      WHERE passenger_id = _passenger_id
        AND status = 'completed') AS total_trips,
    (SELECT ROUND(AVG(pr.stars)::numeric, 2)
       FROM public.passenger_ratings pr
       LEFT JOIN public.trips t ON t.id = pr.trip_id
      WHERE COALESCE(pr.passenger_id, t.passenger_id) = _passenger_id
        AND COALESCE(pr.skipped, false) = false
        AND pr.stars IS NOT NULL) AS avg_rating,
    (SELECT COUNT(*)::int
       FROM public.passenger_ratings pr
       LEFT JOIN public.trips t ON t.id = pr.trip_id
      WHERE COALESCE(pr.passenger_id, t.passenger_id) = _passenger_id
        AND COALESCE(pr.skipped, false) = false
        AND pr.stars IS NOT NULL) AS rating_count;
$function$;

-- Backfill denormalised passenger_id so direct filters / future writers stay consistent.
UPDATE public.passenger_ratings pr
SET passenger_id = t.passenger_id
FROM public.trips t
WHERE pr.trip_id = t.id
  AND pr.passenger_id IS NULL
  AND t.passenger_id IS NOT NULL;
