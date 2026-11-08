-- ============================================================
-- Assigned-page RBAC — shared tables fail-closed (RESTRICTIVE / LOCAL / UNAPPLIED)
-- Branch: fix/assigned-page-rbac
--
-- DO NOT apply to production until explicitly approved.
-- DO NOT apply until:
--   1) 20261231130000 helpers + page RPCs are applied
--   2) Admin UI cutover confirmed (no non-Owner JWT .from(trips|drivers|customers|documents))
--   3) 20261231140000 clear-table page RLS applied (or applied in the same release window after UI)
--
-- Applying this while the UI still uses .from('trips'|…) will break every
-- non-Owner page that touches those tables.
--
-- Depends on:
--   20261231130000_assigned_page_rbac_helpers_and_page_rpcs.sql
--     (staff_is_active_owner, admin_assert_staff_page, admin_page_select, …)
--
-- Shared tables cannot take a safe page OR-list without cross-page exposure.
-- Admin-role policies are replaced with active-Owner-only. Non-Owner access
-- must use page RPCs / Edges from 20261231130000 + gated Edges.
--
-- payment_sessions: already service_role-only — authenticated stays denied.
-- ============================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- trips — Owner-only for direct JWT admin access
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Admins can manage all trips" ON public.trips;
DROP POLICY IF EXISTS "Admins can read all trips" ON public.trips;
DROP POLICY IF EXISTS "Admins can insert trips" ON public.trips;
DROP POLICY IF EXISTS "Admins can update all trips" ON public.trips;
DROP POLICY IF EXISTS "Admins can delete trips" ON public.trips;
DROP POLICY IF EXISTS "Owner can select all trips" ON public.trips;
DROP POLICY IF EXISTS "Owner can insert trips" ON public.trips;
DROP POLICY IF EXISTS "Owner can update all trips" ON public.trips;
DROP POLICY IF EXISTS "Owner can delete trips" ON public.trips;

CREATE POLICY "Owner can select all trips"
  ON public.trips FOR SELECT TO authenticated
  USING (public.staff_is_active_owner());

CREATE POLICY "Owner can insert trips"
  ON public.trips FOR INSERT TO authenticated
  WITH CHECK (public.staff_is_active_owner());

CREATE POLICY "Owner can update all trips"
  ON public.trips FOR UPDATE TO authenticated
  USING (public.staff_is_active_owner())
  WITH CHECK (public.staff_is_active_owner());

CREATE POLICY "Owner can delete trips"
  ON public.trips FOR DELETE TO authenticated
  USING (public.staff_is_active_owner());

REVOKE TRUNCATE ON TABLE public.trips FROM authenticated;

-- ---------------------------------------------------------------------------
-- drivers — Owner-only for admin policies (keep driver own-row)
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Admins can read all drivers" ON public.drivers;
DROP POLICY IF EXISTS "Admins can select all drivers" ON public.drivers;
DROP POLICY IF EXISTS "Admins can update all drivers" ON public.drivers;
DROP POLICY IF EXISTS "Admins can update drivers" ON public.drivers;
DROP POLICY IF EXISTS "Admins can delete drivers" ON public.drivers;
DROP POLICY IF EXISTS "Admins can insert drivers" ON public.drivers;
DROP POLICY IF EXISTS "Owner can select all drivers" ON public.drivers;
DROP POLICY IF EXISTS "Owner can insert drivers" ON public.drivers;
DROP POLICY IF EXISTS "Owner can update all drivers" ON public.drivers;
DROP POLICY IF EXISTS "Owner can delete drivers" ON public.drivers;

CREATE POLICY "Owner can select all drivers"
  ON public.drivers FOR SELECT TO authenticated
  USING (public.staff_is_active_owner());

CREATE POLICY "Owner can insert drivers"
  ON public.drivers FOR INSERT TO authenticated
  WITH CHECK (public.staff_is_active_owner());

CREATE POLICY "Owner can update all drivers"
  ON public.drivers FOR UPDATE TO authenticated
  USING (public.staff_is_active_owner())
  WITH CHECK (public.staff_is_active_owner());

CREATE POLICY "Owner can delete drivers"
  ON public.drivers FOR DELETE TO authenticated
  USING (public.staff_is_active_owner());

REVOKE TRUNCATE ON TABLE public.drivers FROM authenticated;

-- ---------------------------------------------------------------------------
-- customers — Owner-only for admin manage (keep customer own-row)
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Admins can manage all customers" ON public.customers;
DROP POLICY IF EXISTS "Owner can manage all customers" ON public.customers;

CREATE POLICY "Owner can manage all customers"
  ON public.customers FOR ALL TO authenticated
  USING (public.staff_is_active_owner())
  WITH CHECK (public.staff_is_active_owner());

REVOKE TRUNCATE ON TABLE public.customers FROM authenticated;

-- ---------------------------------------------------------------------------
-- documents — Owner-only for admin manage (keep driver/passenger policies)
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Admins can manage all documents" ON public.documents;
DROP POLICY IF EXISTS "Owner can manage all documents" ON public.documents;

CREATE POLICY "Owner can manage all documents"
  ON public.documents FOR ALL TO authenticated
  USING (public.staff_is_active_owner())
  WITH CHECK (public.staff_is_active_owner());

REVOKE TRUNCATE ON TABLE public.documents FROM authenticated;

-- ---------------------------------------------------------------------------
-- payment_sessions — confirm authenticated has no admin ALL; revoke TRUNCATE
-- ---------------------------------------------------------------------------

REVOKE TRUNCATE ON TABLE public.payment_sessions FROM authenticated;

COMMIT;
