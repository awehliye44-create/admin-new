-- ============================================================
-- Assigned-page RBAC — clear-table + catalog page RLS (RESTRICTIVE / LOCAL / UNAPPLIED)
-- Branch: fix/assigned-page-rbac
--
-- DO NOT apply to production until explicitly approved.
-- DO NOT apply until:
--   1) 20261231130000 helpers + page RPCs are applied
--   2) Admin UI cutover that uses admin_page_* / page-gated Edges is deployed
--      and confirmed (old UI that relied on admin-role table policies is gone)
--
-- This migration replaces admin-role policies on clear-mapped tables with
-- exact staff_has_page_access grants, tightens permission-catalog reads to
-- own-role + Owner, and revokes unnecessary privileges.
--
-- Shared tables (trips/drivers/customers/documents) are NOT rewritten here —
-- see 20261231150000.
-- ============================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 2) Permission catalog — own role + Owner only
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Read own role page permissions or manage roles" ON public.role_page_permissions;
CREATE POLICY "Read own role page permissions or owner"
  ON public.role_page_permissions
  FOR SELECT
  TO authenticated
  USING (
    role_id = public.staff_role_id_of(auth.uid())
    OR public.is_owner(auth.uid())
  );

DROP POLICY IF EXISTS "Read own role action permissions or manage roles" ON public.role_action_permissions;
CREATE POLICY "Read own role action permissions or owner"
  ON public.role_action_permissions
  FOR SELECT
  TO authenticated
  USING (
    role_id = public.staff_role_id_of(auth.uid())
    OR public.is_owner(auth.uid())
  );

DROP POLICY IF EXISTS "Read own role or manage roles" ON public.staff_roles_catalog;
CREATE POLICY "Read own role catalog or owner"
  ON public.staff_roles_catalog
  FOR SELECT
  TO authenticated
  USING (
    id = public.staff_role_id_of(auth.uid())
    OR public.is_owner(auth.uid())
  );

DROP POLICY IF EXISTS "Staff profiles viewable by staff or self" ON public.staff_profiles;
CREATE POLICY "Staff profiles viewable by self or owner"
  ON public.staff_profiles
  FOR SELECT
  TO authenticated
  USING (
    auth.uid() = user_id
    OR public.is_owner(auth.uid())
  );

-- ---------------------------------------------------------------------------
-- 3) Clear-mapped admin table policies
-- ---------------------------------------------------------------------------

-- offers
DROP POLICY IF EXISTS "offers_admin_full_read" ON public.offers;
CREATE POLICY "offers_staff_page_read"
  ON public.offers FOR SELECT TO authenticated
  USING (public.staff_has_page_access('offers'));

DROP POLICY IF EXISTS "offers_admin_write" ON public.offers;
CREATE POLICY "offers_staff_page_write"
  ON public.offers FOR ALL TO authenticated
  USING (public.staff_has_page_access('offers'))
  WITH CHECK (public.staff_has_page_access('offers'));

DROP POLICY IF EXISTS "offer_sa_admin_write" ON public.offer_service_areas;
CREATE POLICY "offer_sa_staff_page_write"
  ON public.offer_service_areas FOR ALL TO authenticated
  USING (public.staff_has_page_access('offers'))
  WITH CHECK (public.staff_has_page_access('offers'));

-- offer_redemptions: keep owner/customer row access; admin leg requires offers page
DROP POLICY IF EXISTS "redemptions_owner_read" ON public.offer_redemptions;
CREATE POLICY "redemptions_owner_or_offers_page_read"
  ON public.offer_redemptions FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR public.staff_has_page_access('offers')
  );

-- complaints
DROP POLICY IF EXISTS "Admins can read complaints" ON public.complaints;
CREATE POLICY "Staff with complaints page can read"
  ON public.complaints FOR SELECT TO authenticated
  USING (public.staff_has_page_access('complaints'));

DROP POLICY IF EXISTS "Admins can insert complaints" ON public.complaints;
CREATE POLICY "Staff with complaints page can insert"
  ON public.complaints FOR INSERT TO authenticated
  WITH CHECK (public.staff_has_page_access('complaints'));

DROP POLICY IF EXISTS "Admins can update complaints" ON public.complaints;
CREATE POLICY "Staff with complaints page can update"
  ON public.complaints FOR UPDATE TO authenticated
  USING (public.staff_has_page_access('complaints'))
  WITH CHECK (public.staff_has_page_access('complaints'));

DROP POLICY IF EXISTS "Admins can delete complaints" ON public.complaints;
CREATE POLICY "Staff with complaints page can delete"
  ON public.complaints FOR DELETE TO authenticated
  USING (public.staff_has_page_access('complaints'));

-- promo_codes
DROP POLICY IF EXISTS "Admins can manage promo codes" ON public.promo_codes;
CREATE POLICY "Staff with promo-codes page can manage"
  ON public.promo_codes FOR ALL TO authenticated
  USING (public.staff_has_page_access('promo-codes'))
  WITH CHECK (public.staff_has_page_access('promo-codes'));

-- rider_feedback
DROP POLICY IF EXISTS "Admins can read all feedback" ON public.rider_feedback;
CREATE POLICY "Staff with rider-feedback page can read"
  ON public.rider_feedback FOR SELECT TO authenticated
  USING (public.staff_has_page_access('rider-feedback'));

DROP POLICY IF EXISTS "Admins can update feedback" ON public.rider_feedback;
CREATE POLICY "Staff with rider-feedback page can update"
  ON public.rider_feedback FOR UPDATE TO authenticated
  USING (public.staff_has_page_access('rider-feedback'))
  WITH CHECK (public.staff_has_page_access('rider-feedback'));

DROP POLICY IF EXISTS "Admins can delete feedback" ON public.rider_feedback;
CREATE POLICY "Staff with rider-feedback page can delete"
  ON public.rider_feedback FOR DELETE TO authenticated
  USING (public.staff_has_page_access('rider-feedback'));

-- account_suspensions
DROP POLICY IF EXISTS "Admins can manage suspensions" ON public.account_suspensions;
CREATE POLICY "Staff with suspensions page can manage"
  ON public.account_suspensions FOR ALL TO authenticated
  USING (public.staff_has_page_access('suspensions'))
  WITH CHECK (public.staff_has_page_access('suspensions'));

-- lost_property_cases
DROP POLICY IF EXISTS "Admins can manage lost property cases" ON public.lost_property_cases;
CREATE POLICY "Staff with lost-property page can manage cases"
  ON public.lost_property_cases FOR ALL TO authenticated
  USING (public.staff_has_page_access('lost-property'))
  WITH CHECK (public.staff_has_page_access('lost-property'));

-- invoice_templates
DROP POLICY IF EXISTS "Admins can view invoice templates" ON public.invoice_templates;
DROP POLICY IF EXISTS "Admins can manage templates" ON public.invoice_templates;
CREATE POLICY "Staff with invoice-templates page can read"
  ON public.invoice_templates FOR SELECT TO authenticated
  USING (public.staff_has_page_access('invoice-templates'));
CREATE POLICY "Staff with invoice-templates page can manage"
  ON public.invoice_templates FOR ALL TO authenticated
  USING (public.staff_has_page_access('invoice-templates'))
  WITH CHECK (public.staff_has_page_access('invoice-templates'));

-- statement_runs
DROP POLICY IF EXISTS "Admins can view statement runs" ON public.statement_runs;
DROP POLICY IF EXISTS "Admins can manage statement runs" ON public.statement_runs;
CREATE POLICY "Staff with statement-runs page can read"
  ON public.statement_runs FOR SELECT TO authenticated
  USING (public.staff_has_page_access('statement-runs'));
CREATE POLICY "Staff with statement-runs page can manage"
  ON public.statement_runs FOR ALL TO authenticated
  USING (public.staff_has_page_access('statement-runs'))
  WITH CHECK (public.staff_has_page_access('statement-runs'));

-- invoices
DROP POLICY IF EXISTS "Admins can manage invoices" ON public.invoices;
CREATE POLICY "Staff with invoices page can manage"
  ON public.invoices FOR ALL TO authenticated
  USING (public.staff_has_page_access('invoices'))
  WITH CHECK (public.staff_has_page_access('invoices'));

-- corporate
DROP POLICY IF EXISTS "Admins can manage corporate accounts" ON public.corporate_accounts;
CREATE POLICY "Staff with corporate-accounts page can manage"
  ON public.corporate_accounts FOR ALL TO authenticated
  USING (public.staff_has_page_access('corporate-accounts'))
  WITH CHECK (public.staff_has_page_access('corporate-accounts'));

DROP POLICY IF EXISTS "Admins can select account requests" ON public.corporate_account_requests;
CREATE POLICY "Staff with account-requests page can select"
  ON public.corporate_account_requests FOR SELECT TO authenticated
  USING (public.staff_has_page_access('account-requests'));

-- regions / services / vehicle_types (admin write policies)
DROP POLICY IF EXISTS "Admins can insert regions" ON public.regions;
DROP POLICY IF EXISTS "Admins can update regions" ON public.regions;
DROP POLICY IF EXISTS "Admins can delete regions" ON public.regions;
CREATE POLICY "Staff with regions page can insert"
  ON public.regions FOR INSERT TO authenticated
  WITH CHECK (public.staff_has_page_access('regions'));
CREATE POLICY "Staff with regions page can update"
  ON public.regions FOR UPDATE TO authenticated
  USING (public.staff_has_page_access('regions'))
  WITH CHECK (public.staff_has_page_access('regions'));
CREATE POLICY "Staff with regions page can delete"
  ON public.regions FOR DELETE TO authenticated
  USING (public.staff_has_page_access('regions'));

DROP POLICY IF EXISTS "Admins can insert service areas" ON public.service_areas;
DROP POLICY IF EXISTS "Admins can update service areas" ON public.service_areas;
DROP POLICY IF EXISTS "Admins can delete service areas" ON public.service_areas;
CREATE POLICY "Staff with services page can insert"
  ON public.service_areas FOR INSERT TO authenticated
  WITH CHECK (public.staff_has_page_access('services'));
CREATE POLICY "Staff with services page can update"
  ON public.service_areas FOR UPDATE TO authenticated
  USING (public.staff_has_page_access('services'))
  WITH CHECK (public.staff_has_page_access('services'));
CREATE POLICY "Staff with services page can delete"
  ON public.service_areas FOR DELETE TO authenticated
  USING (public.staff_has_page_access('services'));

DROP POLICY IF EXISTS "Admins can insert vehicle types" ON public.vehicle_types;
DROP POLICY IF EXISTS "Admins can update vehicle types" ON public.vehicle_types;
DROP POLICY IF EXISTS "Admins can delete vehicle types" ON public.vehicle_types;
CREATE POLICY "Staff with vehicle-types page can insert"
  ON public.vehicle_types FOR INSERT TO authenticated
  WITH CHECK (public.staff_has_page_access('vehicle-types'));
CREATE POLICY "Staff with vehicle-types page can update"
  ON public.vehicle_types FOR UPDATE TO authenticated
  USING (public.staff_has_page_access('vehicle-types'))
  WITH CHECK (public.staff_has_page_access('vehicle-types'));
CREATE POLICY "Staff with vehicle-types page can delete"
  ON public.vehicle_types FOR DELETE TO authenticated
  USING (public.staff_has_page_access('vehicle-types'));

-- vehicles (admin SELECT — Vehicles page OR Drivers page join/lookup)
-- Drivers list hydrates vehicles by driver_id; requiring only `vehicles` would
-- break Drivers for staff without that grant. Writes stay on Vehicles page /
-- existing driver-owned policies.
DROP POLICY IF EXISTS "Admins can read all vehicles" ON public.vehicles;
DROP POLICY IF EXISTS "Staff with vehicles page can read" ON public.vehicles;
CREATE POLICY "Staff with vehicles or drivers page can read vehicles"
  ON public.vehicles FOR SELECT TO authenticated
  USING (public.staff_has_any_page_access(ARRAY['vehicles', 'drivers']));

-- payouts
DROP POLICY IF EXISTS "Admins can view all payout batches" ON public.payout_batches;
DROP POLICY IF EXISTS "Admins can create payout batches" ON public.payout_batches;
DROP POLICY IF EXISTS "Admins can update payout batches" ON public.payout_batches;
CREATE POLICY "Staff with payout-ledger page can read batches"
  ON public.payout_batches FOR SELECT TO authenticated
  USING (public.staff_has_page_access('payout-ledger'));
CREATE POLICY "Staff with payout-ledger page can insert batches"
  ON public.payout_batches FOR INSERT TO authenticated
  WITH CHECK (public.staff_has_page_access('payout-ledger'));
CREATE POLICY "Staff with payout-ledger page can update batches"
  ON public.payout_batches FOR UPDATE TO authenticated
  USING (public.staff_has_page_access('payout-ledger'))
  WITH CHECK (public.staff_has_page_access('payout-ledger'));

DROP POLICY IF EXISTS "Admins can view all payout items" ON public.payout_items;
DROP POLICY IF EXISTS "Admins can create payout items" ON public.payout_items;
DROP POLICY IF EXISTS "Admins can update payout items" ON public.payout_items;
CREATE POLICY "Staff with payout-ledger page can read items"
  ON public.payout_items FOR SELECT TO authenticated
  USING (public.staff_has_page_access('payout-ledger'));
CREATE POLICY "Staff with payout-ledger page can insert items"
  ON public.payout_items FOR INSERT TO authenticated
  WITH CHECK (public.staff_has_page_access('payout-ledger'));
CREATE POLICY "Staff with payout-ledger page can update items"
  ON public.payout_items FOR UPDATE TO authenticated
  USING (public.staff_has_page_access('payout-ledger'))
  WITH CHECK (public.staff_has_page_access('payout-ledger'));

-- notifications (admin manage only)
DROP POLICY IF EXISTS "Admins can manage all notifications" ON public.notifications;
CREATE POLICY "Staff with notifications page can manage"
  ON public.notifications FOR ALL TO authenticated
  USING (public.staff_has_page_access('notifications'))
  WITH CHECK (public.staff_has_page_access('notifications'));

-- ---------------------------------------------------------------------------
-- 4) Driver wallet ledger — page grant (not finance role enum)
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "driver_wallet_ledger_finance_read" ON public.driver_wallet_ledger;
CREATE POLICY "driver_wallet_ledger_staff_page_read"
  ON public.driver_wallet_ledger
  FOR SELECT
  TO authenticated
  USING (public.staff_has_page_access('driver-wallet-ledger'));

-- ---------------------------------------------------------------------------
-- 5) Privilege hygiene — revoke TRUNCATE from authenticated where safe
-- ---------------------------------------------------------------------------

REVOKE TRUNCATE ON TABLE public.role_page_permissions FROM authenticated;
REVOKE TRUNCATE ON TABLE public.role_action_permissions FROM authenticated;
REVOKE TRUNCATE ON TABLE public.staff_roles_catalog FROM authenticated;
REVOKE TRUNCATE ON TABLE public.staff_profiles FROM authenticated;
REVOKE TRUNCATE ON TABLE public.offers FROM authenticated;
REVOKE TRUNCATE ON TABLE public.offer_service_areas FROM authenticated;
REVOKE TRUNCATE ON TABLE public.complaints FROM authenticated;
REVOKE TRUNCATE ON TABLE public.promo_codes FROM authenticated;
REVOKE TRUNCATE ON TABLE public.rider_feedback FROM authenticated;
REVOKE TRUNCATE ON TABLE public.account_suspensions FROM authenticated;
REVOKE TRUNCATE ON TABLE public.lost_property_cases FROM authenticated;
REVOKE TRUNCATE ON TABLE public.invoice_templates FROM authenticated;
REVOKE TRUNCATE ON TABLE public.statement_runs FROM authenticated;
REVOKE TRUNCATE ON TABLE public.invoices FROM authenticated;
REVOKE TRUNCATE ON TABLE public.corporate_accounts FROM authenticated;
REVOKE TRUNCATE ON TABLE public.corporate_account_requests FROM authenticated;
REVOKE TRUNCATE ON TABLE public.regions FROM authenticated;
REVOKE TRUNCATE ON TABLE public.service_areas FROM authenticated;
REVOKE TRUNCATE ON TABLE public.vehicle_types FROM authenticated;
REVOKE TRUNCATE ON TABLE public.vehicles FROM authenticated;
REVOKE TRUNCATE ON TABLE public.payout_batches FROM authenticated;
REVOKE TRUNCATE ON TABLE public.payout_items FROM authenticated;
REVOKE TRUNCATE ON TABLE public.notifications FROM authenticated;
REVOKE TRUNCATE ON TABLE public.driver_wallet_ledger FROM authenticated;

-- Catalog writes must go through Owner SECURITY DEFINER RPCs
REVOKE INSERT, UPDATE, DELETE ON TABLE public.staff_roles_catalog FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.role_action_permissions FROM authenticated;

COMMIT;
