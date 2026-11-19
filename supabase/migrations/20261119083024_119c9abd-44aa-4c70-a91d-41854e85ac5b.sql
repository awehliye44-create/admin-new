DO $mig$
DECLARE
  v_def text;
  v_new text;
BEGIN
  -- Remove the admin bypass from upsert_driver_presence: no admin screen uses it, and
  -- only the driver themself or the backend may write a driver's presence.
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'upsert_driver_presence';
  v_new := replace(v_def,
    replace($s$  -- Ownership: caller must own the driver (or service_role/admin).~NL~  IF auth.role() <> 'service_role'~NL~     AND auth.uid() IS DISTINCT FROM v_driver.user_id~NL~     AND NOT public.has_role(auth.uid(), 'admin'::public.app_role)~NL~  THEN$s$, '~NL~', chr(10)),
    replace($s$  -- Ownership: caller must own the driver (or service_role).~NL~  IF auth.role() <> 'service_role'~NL~     AND auth.uid() IS DISTINCT FROM v_driver.user_id~NL~  THEN$s$, '~NL~', chr(10)));
  IF v_new = v_def THEN
    RAISE EXCEPTION 'upsert_driver_presence: ownership block not found';
  END IF;
  EXECUTE v_new;
END
$mig$;

-- Direct rider inserts into location diagnostics: match the rider via customers.user_id
-- and only allow the trip's own driver (or none) on the row.
DROP POLICY IF EXISTS "Customers insert trip location publish diagnostics" ON public.driver_location_publish_diagnostics;
CREATE POLICY "Customers insert trip location publish diagnostics"
ON public.driver_location_publish_diagnostics
FOR INSERT TO authenticated
WITH CHECK (
  origin = 'customer_client'
  AND trip_id IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM public.trips t
    JOIN public.customers c ON c.id = t.passenger_id
    WHERE t.id = driver_location_publish_diagnostics.trip_id
      AND c.user_id = auth.uid()
      AND (
        driver_location_publish_diagnostics.driver_id IS NULL
        OR driver_location_publish_diagnostics.driver_id IN (t.driver_id, t.confirmed_driver_id)
      )
  )
);