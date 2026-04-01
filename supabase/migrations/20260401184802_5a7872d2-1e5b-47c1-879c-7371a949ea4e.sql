
-- ============================================================
-- FIX 1: user_directory — restrict to admins only
-- ============================================================
DROP VIEW IF EXISTS public.user_directory;

CREATE OR REPLACE VIEW public.user_directory
WITH (security_barrier = true, security_invoker = on) AS
SELECT p.user_id,
    p.full_name,
    p.phone,
    (p.role)::text AS user_type,
    CASE
        WHEN (p.role = 'admin'::app_user_role) THEN COALESCE(
            CASE WHEN sp.is_active THEN 'active'::text ELSE 'inactive'::text END, 'active'::text)
        WHEN (p.role = 'driver'::app_user_role) THEN COALESCE(d.approval_status, 'pending'::text)
        WHEN (p.role = 'customer'::app_user_role) THEN 'active'::text
        WHEN (p.role = 'corporate'::app_user_role) THEN COALESCE(cu.status, 'active'::text)
        ELSE 'unknown'::text
    END AS status,
    CASE
        WHEN (p.role = 'admin'::app_user_role) THEN (sp.id IS NOT NULL)
        WHEN (p.role = 'driver'::app_user_role) THEN (d.id IS NOT NULL)
        WHEN (p.role = 'customer'::app_user_role) THEN (c.id IS NOT NULL)
        WHEN (p.role = 'corporate'::app_user_role) THEN (cu.id IS NOT NULL)
        ELSE false
    END AS has_linked_record,
    p.created_at,
    COALESCE(
        CASE WHEN (p.role = 'driver'::app_user_role) THEN d.email ELSE NULL::text END,
        CASE WHEN (p.role = 'corporate'::app_user_role) THEN cu.email ELSE NULL::text END,
        sp.username) AS email
FROM profiles p
    LEFT JOIN staff_profiles sp ON sp.user_id = p.user_id AND p.role = 'admin'::app_user_role
    LEFT JOIN drivers d ON d.user_id = p.user_id AND p.role = 'driver'::app_user_role
    LEFT JOIN customers c ON c.user_id = p.user_id AND p.role = 'customer'::app_user_role
    LEFT JOIN corporate_users cu ON cu.user_id = p.user_id AND p.role = 'corporate'::app_user_role
WHERE has_role(auth.uid(), 'admin'::app_role);

-- ============================================================
-- FIX 2: driver_document_status — restrict to admins + own driver
-- ============================================================
DROP VIEW IF EXISTS public.driver_document_status;

CREATE OR REPLACE VIEW public.driver_document_status
WITH (security_barrier = true, security_invoker = on) AS
SELECT d.id AS driver_id,
    d.first_name,
    d.last_name,
    d.documents_approved,
    d.approval_status,
    count(doc.id) FILTER (WHERE doc.status = 'approved') AS approved_docs,
    count(doc.id) FILTER (WHERE doc.status = 'pending') AS pending_docs,
    count(doc.id) FILTER (WHERE doc.status = 'rejected') AS rejected_docs,
    count(doc.id) AS total_docs
FROM drivers d
    LEFT JOIN documents doc ON doc.driver_id = d.id
WHERE has_role(auth.uid(), 'admin'::app_role)
   OR d.user_id = auth.uid()
GROUP BY d.id, d.first_name, d.last_name, d.documents_approved, d.approval_status;

-- ============================================================
-- FIX 3: Fix passenger RLS policies (passenger_id != auth.uid())
-- ============================================================

-- trip_stops: Passengers can view their trip stops
DROP POLICY IF EXISTS "Passengers can view their trip stops" ON public.trip_stops;
CREATE POLICY "Passengers can view their trip stops" ON public.trip_stops
FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM trips t
    WHERE t.id = trip_stops.trip_id
      AND t.passenger_id IN (SELECT id FROM customers WHERE user_id = auth.uid())
  )
);

-- trip_stops: Passengers can create stops for pending trips
DROP POLICY IF EXISTS "Passengers can create stops for pending trips" ON public.trip_stops;
CREATE POLICY "Passengers can create stops for pending trips" ON public.trip_stops
FOR INSERT WITH CHECK (
  trip_id IN (
    SELECT trips.id FROM trips
    WHERE trips.passenger_id IN (SELECT id FROM customers WHERE user_id = auth.uid())
      AND trips.status = ANY (ARRAY['pending','searching'])
  )
);

-- trip_stops: Passengers can modify stops for pending trips
DROP POLICY IF EXISTS "Passengers can modify stops for pending trips" ON public.trip_stops;
CREATE POLICY "Passengers can modify stops for pending trips" ON public.trip_stops
FOR UPDATE USING (
  trip_id IN (
    SELECT trips.id FROM trips
    WHERE trips.passenger_id IN (SELECT id FROM customers WHERE user_id = auth.uid())
      AND trips.status = ANY (ARRAY['pending','searching'])
  )
);

-- trip_stops: Passengers can delete stops for pending trips
DROP POLICY IF EXISTS "Passengers can delete stops for pending trips" ON public.trip_stops;
CREATE POLICY "Passengers can delete stops for pending trips" ON public.trip_stops
FOR DELETE USING (
  trip_id IN (
    SELECT trips.id FROM trips
    WHERE trips.passenger_id IN (SELECT id FROM customers WHERE user_id = auth.uid())
      AND trips.status = ANY (ARRAY['pending','searching'])
  )
);

-- trip_stop_waiting: Customers can read waiting for their trips
DROP POLICY IF EXISTS "Customers can read waiting for their trips" ON public.trip_stop_waiting;
CREATE POLICY "Customers can read waiting for their trips" ON public.trip_stop_waiting
FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM trips t
    WHERE t.id = trip_stop_waiting.trip_id
      AND t.passenger_id IN (SELECT id FROM customers WHERE user_id = auth.uid())
  )
);

-- trip_change_requests: Customers can create modification requests
DROP POLICY IF EXISTS "Customers can create modification requests" ON public.trip_change_requests;
CREATE POLICY "Customers can create modification requests" ON public.trip_change_requests
FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1 FROM trips t
    WHERE t.id = trip_change_requests.trip_id
      AND t.passenger_id IN (SELECT id FROM customers WHERE user_id = auth.uid())
      AND t.status = ANY (ARRAY['accepted','en_route_to_pickup','arrived','in_progress'])
  )
);

-- trip_change_requests: Customers can view their trip modification requests
DROP POLICY IF EXISTS "Customers can view their trip modification requests" ON public.trip_change_requests;
CREATE POLICY "Customers can view their trip modification requests" ON public.trip_change_requests
FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM trips t
    WHERE t.id = trip_change_requests.trip_id
      AND t.passenger_id IN (SELECT id FROM customers WHERE user_id = auth.uid())
  )
);

-- trip_offers: Customers can view offers on own trips
DROP POLICY IF EXISTS "Customers can view offers on own trips" ON public.trip_offers;
CREATE POLICY "Customers can view offers on own trips" ON public.trip_offers
FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM trips t
    WHERE t.id = trip_offers.trip_id
      AND t.passenger_id IN (SELECT id FROM customers WHERE user_id = auth.uid())
  )
);

-- fare_audit_logs: Users can read own trip fare audit logs
DROP POLICY IF EXISTS "Users can read own trip fare audit logs" ON public.fare_audit_logs;
CREATE POLICY "Users can read own trip fare audit logs" ON public.fare_audit_logs
FOR SELECT USING (
  has_role(auth.uid(), 'admin'::app_role)
  OR EXISTS (
    SELECT 1 FROM trips t
    WHERE t.id = fare_audit_logs.trip_id
      AND (
        t.passenger_id IN (SELECT id FROM customers WHERE user_id = auth.uid())
        OR t.driver_id IN (SELECT id FROM drivers WHERE user_id = auth.uid())
      )
  )
);

-- payments: Users can view their own trip payments
DROP POLICY IF EXISTS "Users can view their own trip payments" ON public.payments;
CREATE POLICY "Users can view their own trip payments" ON public.payments
FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM trips t
    WHERE t.id = payments.trip_id
      AND t.passenger_id IN (SELECT id FROM customers WHERE user_id = auth.uid())
  )
);

-- ============================================================
-- FIX 4: Call masking — create restricted view, remove driver base table access
-- ============================================================

-- Create a restricted view that hides real phone numbers
CREATE OR REPLACE VIEW public.driver_call_masking_view
WITH (security_barrier = true, security_invoker = on) AS
SELECT
    cms.id,
    cms.trip_id,
    cms.caller_id,
    cms.status,
    cms.expires_at,
    cms.created_at
FROM call_masking_sessions cms
WHERE cms.driver_id IN (SELECT id FROM drivers WHERE user_id = auth.uid())
  AND cms.status = 'active';

-- Remove direct driver access to the base table
DROP POLICY IF EXISTS "Drivers can view own active sessions" ON public.call_masking_sessions;
