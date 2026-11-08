-- ============================================================
-- HOTFIX: permission-catalog RLS must not call is_owner()
--
-- Phase C (20261231140000) used public.is_owner(auth.uid()) in four
-- catalog policies. Live EXECUTE on is_owner(uuid) is service_role-only
-- (A7B lock), so authenticated permission load fails with:
--   permission denied for function is_owner
--
-- Replace with public.staff_is_active_owner() (already EXECUTE for
-- authenticated). Preserve each policy's self / own-role OR Owner shape.
-- Do NOT grant authenticated EXECUTE on is_owner.
-- ============================================================

BEGIN;

DROP POLICY IF EXISTS "Read own role page permissions or owner" ON public.role_page_permissions;
CREATE POLICY "Read own role page permissions or owner"
  ON public.role_page_permissions
  FOR SELECT
  TO authenticated
  USING (
    role_id = public.staff_role_id_of(auth.uid())
    OR public.staff_is_active_owner()
  );

DROP POLICY IF EXISTS "Read own role action permissions or owner" ON public.role_action_permissions;
CREATE POLICY "Read own role action permissions or owner"
  ON public.role_action_permissions
  FOR SELECT
  TO authenticated
  USING (
    role_id = public.staff_role_id_of(auth.uid())
    OR public.staff_is_active_owner()
  );

DROP POLICY IF EXISTS "Read own role catalog or owner" ON public.staff_roles_catalog;
CREATE POLICY "Read own role catalog or owner"
  ON public.staff_roles_catalog
  FOR SELECT
  TO authenticated
  USING (
    id = public.staff_role_id_of(auth.uid())
    OR public.staff_is_active_owner()
  );

DROP POLICY IF EXISTS "Staff profiles viewable by self or owner" ON public.staff_profiles;
CREATE POLICY "Staff profiles viewable by self or owner"
  ON public.staff_profiles
  FOR SELECT
  TO authenticated
  USING (
    auth.uid() = user_id
    OR public.staff_is_active_owner()
  );

COMMIT;
