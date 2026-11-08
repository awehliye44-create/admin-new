-- ============================================================
-- HOTFIX: Roles & Permissions JWT RLS must not call is_owner()
--
-- After A7B, authenticated has no EXECUTE on public.is_owner(uuid).
-- Three live Roles policies still invoke it:
--   - user_roles INSERT "Admins can insert non-admin roles; owner any"
--   - user_roles DELETE "Admins can delete non-admin roles; owner any"
--   - audit_logs SELECT RESTRICTIVE "Roles audit visible to owner only"
--
-- Actor checks → public.staff_is_active_owner() (EXECUTE for authenticated).
-- Target Owner protection on DELETE → public.staff_can_manage_roles(user_id)
--   (DEFINER wrapper; same boolean as is_owner(user_id), EXECUTE allowed).
--
-- Also add Owner DELETE on profiles so Roles remove-staff can clear the
-- profiles row (no DELETE policy exists today; SELECT/UPDATE stay admin
-- has_role until 20261231180000 fail-closed cutover).
--
-- Do NOT grant authenticated EXECUTE on is_owner.
-- ============================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- user_roles — Owner may mint/revoke admin; admins only non-admin roles
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Admins can insert non-admin roles; owner any" ON public.user_roles;
CREATE POLICY "Admins can insert non-admin roles; owner any"
  ON public.user_roles
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.has_role(auth.uid(), 'admin'::public.app_role)
    AND (
      role <> 'admin'::public.app_role
      OR public.staff_is_active_owner()
    )
  );

DROP POLICY IF EXISTS "Admins can delete non-admin roles; owner any" ON public.user_roles;
CREATE POLICY "Admins can delete non-admin roles; owner any"
  ON public.user_roles
  FOR DELETE
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin'::public.app_role)
    AND (
      role <> 'admin'::public.app_role
      OR (
        public.staff_is_active_owner()
        AND NOT public.staff_can_manage_roles(user_id)
      )
    )
  );

-- ---------------------------------------------------------------------------
-- audit_logs — roles.* history is Owner-only (RESTRICTIVE)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Roles audit visible to owner only" ON public.audit_logs;
CREATE POLICY "Roles audit visible to owner only"
  ON public.audit_logs
  AS RESTRICTIVE
  FOR SELECT
  TO authenticated
  USING (
    event_type NOT LIKE 'roles.%'
    OR public.staff_is_active_owner()
  );

-- ---------------------------------------------------------------------------
-- profiles — Owner DELETE for Roles remove-staff path (additive)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Owner can delete profiles for role management" ON public.profiles;
CREATE POLICY "Owner can delete profiles for role management"
  ON public.profiles
  FOR DELETE
  TO authenticated
  USING (public.staff_is_active_owner());

COMMIT;
