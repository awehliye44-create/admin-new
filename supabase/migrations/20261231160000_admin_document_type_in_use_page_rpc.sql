-- ============================================================
-- Assigned-page RBAC — document-type in-use check (LOCAL / UNAPPLIED)
-- Branch: fix/assigned-page-rbac
--
-- DO NOT apply to production until explicitly approved.
-- Depends on: 20261231130000 (admin_assert_staff_page / staff_has_page_access)
--
-- useDeleteDocumentType needs to know whether any documents rows reference a
-- type before hard-delete vs soft-deactivate. Direct JWT .from('documents')
-- fails for non-Owner after 20261231150000 Owner-only RLS.
--
-- This RPC is intentionally narrow: asserts exact page grant
-- `document-management`, returns boolean only, does not expose document rows,
-- and does not change documents table RLS.
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.admin_document_type_in_use(p_document_type_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_slug text;
BEGIN
  PERFORM public.admin_assert_staff_page('document-management');

  IF p_document_type_id IS NULL THEN
    RAISE EXCEPTION 'document type id required' USING ERRCODE = '22023';
  END IF;

  SELECT dt.slug
  INTO v_slug
  FROM public.document_types dt
  WHERE dt.id = p_document_type_id;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM public.documents d
    WHERE d.document_type_id = p_document_type_id
       OR d.document_type = v_slug
  );
END;
$fn$;

COMMENT ON FUNCTION public.admin_document_type_in_use(uuid) IS
  'document-management page only: true if any documents row references the type by id or slug. Does not weaken documents Owner-only RLS.';

REVOKE ALL ON FUNCTION public.admin_document_type_in_use(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_document_type_in_use(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_document_type_in_use(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_document_type_in_use(uuid) TO service_role;

COMMIT;
