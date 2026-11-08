-- ============================================================
-- Assigned-page RBAC — catalog tables restrictive RLS
-- Branch: fix/assigned-page-rbac
-- LOCAL / UNAPPLIED — DO NOT apply until UI cutover to 20261231170000 RPCs is complete.
--
-- Depends on:
--   20261231130000 helpers
--   20261231170000 catalog page RPCs
--   Admin UI cutover off has_role(admin) JWT for these tables
--
-- Removes admin-wide has_role(admin) bypasses. Preserves:
--   - driver own-row policies on driver_service_areas
--   - customer/corporate own-row on corporate_fare_rules
--   - profiles self-read
--   - Owner staff_is_active_owner where needed (roles profiles)
--   - service_areas anon/member/public signup reads + services-page mutate
--   - document_types public read of active types (driver app)
-- ============================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- driver_service_areas — drop admin-wide; staff via page RPC only
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Admins can read all driver service areas" ON public.driver_service_areas;
DROP POLICY IF EXISTS "Admins can insert driver service areas" ON public.driver_service_areas;
DROP POLICY IF EXISTS "Admins can update driver service areas" ON public.driver_service_areas;
DROP POLICY IF EXISTS "Admins can delete driver service areas" ON public.driver_service_areas;

-- Driver own-row policies retained (Drivers can read/add/remove own…).

-- ---------------------------------------------------------------------------
-- fare_pricing_settings — drop admin-wide; staff via page RPC only
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Admins can manage fare pricing settings" ON public.fare_pricing_settings;
DROP POLICY IF EXISTS "Admins can read fare pricing settings" ON public.fare_pricing_settings;

-- ---------------------------------------------------------------------------
-- corporate_fare_rules — drop admin manage; staff via page RPC only
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Admins can manage corporate fare rules" ON public.corporate_fare_rules;
-- Corporate member/user SELECT policies retained.

-- ---------------------------------------------------------------------------
-- fare_audit_logs — drop admin manage (no Admin UI JWT cutover yet → Owner/service only)
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Admins can manage fare audit logs" ON public.fare_audit_logs;

CREATE POLICY "Owner can manage fare audit logs"
  ON public.fare_audit_logs FOR ALL TO authenticated
  USING (public.staff_is_active_owner())
  WITH CHECK (public.staff_is_active_owner());

-- Keep passenger own-trip SELECT if present (recreate without admin OR).
DROP POLICY IF EXISTS "Users can read own trip fare audit logs" ON public.fare_audit_logs;
CREATE POLICY "Users can read own trip fare audit logs"
  ON public.fare_audit_logs FOR SELECT TO authenticated
  USING (
    public.staff_is_active_owner()
    OR EXISTS (
      SELECT 1
      FROM public.trips t
      WHERE t.id = fare_audit_logs.trip_id
        AND (
          t.passenger_id IN (SELECT c.id FROM public.customers c WHERE c.user_id = auth.uid())
          OR t.driver_id IN (SELECT d.id FROM public.drivers d WHERE d.user_id = auth.uid())
        )
    )
  );

-- ---------------------------------------------------------------------------
-- profiles — remove admin-wide; keep self-read; Owner for role-management
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Admins can read all profiles" ON public.profiles;
DROP POLICY IF EXISTS "Admins can update profiles" ON public.profiles;
-- Idempotent vs 20261231152000 Owner DELETE hotfix (and any partial re-apply).
DROP POLICY IF EXISTS "Owner can select profiles for role management" ON public.profiles;
DROP POLICY IF EXISTS "Owner can update profiles for role management" ON public.profiles;
DROP POLICY IF EXISTS "Owner can delete profiles for role management" ON public.profiles;

-- "Users can read own profile" retained.

CREATE POLICY "Owner can select profiles for role management"
  ON public.profiles FOR SELECT TO authenticated
  USING (public.staff_is_active_owner());

CREATE POLICY "Owner can update profiles for role management"
  ON public.profiles FOR UPDATE TO authenticated
  USING (public.staff_is_active_owner())
  WITH CHECK (public.staff_is_active_owner());

CREATE POLICY "Owner can delete profiles for role management"
  ON public.profiles FOR DELETE TO authenticated
  USING (public.staff_is_active_owner());

-- ---------------------------------------------------------------------------
-- service_areas — remove is_platform_staff broad read; keep public/member + services mutate
-- Staff admin UI must use admin_service_areas_lookup (DEFINER).
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Staff read all service areas" ON public.service_areas;

-- Retain:
--   Anyone can read active service areas (anon)
--   Anyone can read signup-enabled service areas (public)
--   Members read active service areas (authenticated + is_platform_member)
--   Staff with services page can insert/update/delete

-- ---------------------------------------------------------------------------
-- document_types — exact document-management for staff writes; keep active public read
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Admins can manage document types" ON public.document_types;

CREATE POLICY "Staff with document-management page can manage document types"
  ON public.document_types FOR ALL TO authenticated
  USING (public.staff_has_page_access('document-management'))
  WITH CHECK (public.staff_has_page_access('document-management'));

-- "Anyone can read active document types" retained.

-- ---------------------------------------------------------------------------
-- service_area_document_rules — exact document-management; keep driver own-SA read
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Admins can manage service area document rules" ON public.service_area_document_rules;

CREATE POLICY "Staff with document-management page can manage SA document rules"
  ON public.service_area_document_rules FOR ALL TO authenticated
  USING (public.staff_has_page_access('document-management'))
  WITH CHECK (public.staff_has_page_access('document-management'));

-- Driver SA read policy retained.

-- ---------------------------------------------------------------------------
-- Adjacent fare/dispatch tables — drop admin-wide; staff via page RPC only
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Admins can read stop waiting settings" ON public.stop_waiting_settings;
DROP POLICY IF EXISTS "stop_waiting_settings admin manage" ON public.stop_waiting_settings;
-- Members read active area stop waiting settings retained (rider/driver apps).

DROP POLICY IF EXISTS "Admins can manage dispatch settings" ON public.dispatch_settings;
DROP POLICY IF EXISTS "Admins can read dispatch settings" ON public.dispatch_settings;

DROP POLICY IF EXISTS "Admins can delete service area cancellation fees" ON public.service_area_cancellation_fees;
DROP POLICY IF EXISTS "Admins can insert service area cancellation fees" ON public.service_area_cancellation_fees;
DROP POLICY IF EXISTS "Admins can update service area cancellation fees" ON public.service_area_cancellation_fees;

DROP POLICY IF EXISTS "Admins can delete service area vehicle pricing" ON public.service_area_vehicle_pricing;
DROP POLICY IF EXISTS "Admins can insert service area vehicle pricing" ON public.service_area_vehicle_pricing;
DROP POLICY IF EXISTS "Admins can read vehicle pricing" ON public.service_area_vehicle_pricing;
DROP POLICY IF EXISTS "Admins can update service area vehicle pricing" ON public.service_area_vehicle_pricing;

-- ---------------------------------------------------------------------------
-- fare_audit_logs — INTENTIONAL Owner-only for staff
-- No Admin UI .from('fare_audit_logs') callers. Writes are Edge service_role
-- (stop-workflow). Passenger/driver own-trip SELECT retained above.
-- ---------------------------------------------------------------------------

COMMIT;
