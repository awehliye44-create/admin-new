-- 1) Staff username on every audit entry + mark entries rebuilt from earlier records
ALTER TABLE public.driver_compliance_audit_log
  ADD COLUMN actor_username text,
  ADD COLUMN source text NOT NULL DEFAULT 'live';

CREATE OR REPLACE FUNCTION public.driver_compliance_audit_fill_username()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.actor_username IS NULL AND NEW.actor_user_id IS NOT NULL THEN
    SELECT NULLIF(btrim(sp.username), '') INTO NEW.actor_username
      FROM public.staff_profiles sp WHERE sp.user_id = NEW.actor_user_id LIMIT 1;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.driver_compliance_audit_fill_username() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER driver_compliance_audit_fill_username
  BEFORE INSERT ON public.driver_compliance_audit_log
  FOR EACH ROW EXECUTE FUNCTION public.driver_compliance_audit_fill_username();

ALTER TABLE public.driver_compliance_audit_log DISABLE TRIGGER driver_compliance_audit_log_immutable;
UPDATE public.driver_compliance_audit_log l
   SET actor_username = NULLIF(btrim(sp.username), '')
  FROM public.staff_profiles sp
 WHERE sp.user_id = l.actor_user_id AND l.actor_username IS NULL;
ALTER TABLE public.driver_compliance_audit_log ENABLE TRIGGER driver_compliance_audit_log_immutable;

-- 2) A driver re-upload must not reset the previous (rejected/pending/expired) version to pending.
CREATE OR REPLACE FUNCTION public.guard_driver_document_writes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_is_admin boolean;
BEGIN
  IF current_setting('onecab.admin_page_mutate', true) = '1' THEN
    RETURN NEW;
  END IF;

  v_is_admin := public.has_role(auth.uid(), 'admin'::app_role);
  IF v_is_admin THEN
    RETURN NEW;
  END IF;

  IF auth.uid() IS NULL AND auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  -- Versioning demote/link (is_current / superseded_by only) keeps the old row's review outcome.
  IF TG_OP = 'UPDATE' AND public.document_update_is_versioning_only(OLD, NEW) THEN
    RETURN NEW;
  END IF;

  NEW.status := 'pending';
  NEW.reviewed_by := NULL;
  NEW.reviewed_at := NULL;
  NEW.rejection_reason := NULL;

  RETURN NEW;
END;
$function$;

-- 3) Restore the PHL version that today's re-upload wrongly reset (outcome taken from the audit entry)
DO $$
DECLARE r record;
BEGIN
  ALTER TABLE public.documents DISABLE TRIGGER documents_compliance_audit;
  FOR r IN
    SELECT l.entity_id, l.driver_id, l.entity_label, l.changes
      FROM public.driver_compliance_audit_log l
      JOIN public.documents d ON d.id = l.entity_id
     WHERE l.entity_type = 'document' AND l.action = 'set_pending'
       AND l.changes->'status'->>'from' = 'rejected'
       AND l.changes->'is_current'->>'to' = 'false'
       AND d.status = 'pending' AND d.is_current = false
  LOOP
    PERFORM set_config('onecab.admin_page_mutate', '1', true);
    UPDATE public.documents
       SET status = 'rejected', rejection_reason = r.changes->'rejection_reason'->>'from'
     WHERE id = r.entity_id;
    PERFORM set_config('onecab.admin_page_mutate', '', true);
    INSERT INTO public.driver_compliance_audit_log
      (driver_id, entity_type, entity_id, entity_label, action, changes, actor_kind, actor_name, source)
    VALUES (r.driver_id, 'document', r.entity_id, r.entity_label, 'restored',
      jsonb_build_object('status', jsonb_build_object('from', 'pending', 'to', 'rejected'),
                         'rejection_reason', jsonb_build_object('from', null, 'to', r.changes->'rejection_reason'->'from')),
      'system', 'System', 'live');
  END LOOP;
  ALTER TABLE public.documents ENABLE TRIGGER documents_compliance_audit;
END $$;

-- 4) Rebuild earlier uploads / approvals / rejections from saved records (before the log started)
INSERT INTO public.driver_compliance_audit_log
  (driver_id, entity_type, entity_id, entity_label, action, changes, actor_user_id, actor_kind, actor_name, source, created_at)
SELECT d.driver_id, 'document', d.id,
       COALESCE(NULLIF(btrim(d.document_name), ''), d.document_type),
       'uploaded',
       jsonb_strip_nulls(jsonb_build_object(
         'document_name', jsonb_build_object('from', null, 'to', d.document_name),
         'expiry_date', CASE WHEN d.expiry_date IS NOT NULL THEN jsonb_build_object('from', null, 'to', d.expiry_date) END)),
       a.uid, a.actor->>'kind', a.actor->>'name', 'backfill', d.created_at
  FROM public.documents d
  LEFT JOIN public.drivers dr ON dr.id = d.driver_id
  CROSS JOIN LATERAL (SELECT COALESCE(d.uploaded_by, dr.user_id) AS uid) u
  CROSS JOIN LATERAL (SELECT u.uid, public.driver_compliance_audit_actor(u.uid) AS actor) a
 WHERE d.created_at < timestamptz '2026-11-23 20:28:53+00';

INSERT INTO public.driver_compliance_audit_log
  (driver_id, entity_type, entity_id, entity_label, action, changes, actor_user_id, actor_kind, actor_name, source, created_at)
SELECT d.driver_id, 'document', d.id,
       COALESCE(NULLIF(btrim(d.document_name), ''), d.document_type),
       d.status,
       jsonb_strip_nulls(jsonb_build_object(
         'status', jsonb_build_object('from', null, 'to', d.status),
         'rejection_reason', CASE WHEN d.status = 'rejected' AND d.rejection_reason IS NOT NULL
                                  THEN jsonb_build_object('from', null, 'to', d.rejection_reason) END)),
       d.reviewed_by, a.actor->>'kind', a.actor->>'name', 'backfill', d.reviewed_at
  FROM public.documents d
  CROSS JOIN LATERAL (SELECT public.driver_compliance_audit_actor(d.reviewed_by) AS actor) a
 WHERE d.reviewed_at IS NOT NULL
   AND d.reviewed_at < timestamptz '2026-11-23 20:28:53+00'
   AND d.status IN ('approved', 'rejected');

INSERT INTO public.driver_compliance_audit_log
  (driver_id, entity_type, entity_id, entity_label, action, changes, actor_user_id, actor_kind, actor_name, source, created_at)
SELECT r.driver_id, 'vehicle_change_request', r.id,
       btrim(concat_ws(' ', r.requested_year::text, r.requested_make, r.requested_model, '·', r.requested_license_plate)),
       'change_requested',
       public.driver_compliance_audit_diff(
         jsonb_build_object('make', r.previous_make, 'model', r.previous_model, 'year', r.previous_year,
                            'color', r.previous_color, 'license_plate', r.previous_license_plate),
         jsonb_build_object('make', r.requested_make, 'model', r.requested_model, 'year', r.requested_year,
                            'color', r.requested_color, 'license_plate', r.requested_license_plate),
         ARRAY['make','model','year','color','license_plate']),
       dr.user_id, a.actor->>'kind', a.actor->>'name', 'backfill', r.created_at
  FROM public.vehicle_change_requests r
  LEFT JOIN public.drivers dr ON dr.id = r.driver_id
  CROSS JOIN LATERAL (SELECT public.driver_compliance_audit_actor(dr.user_id) AS actor) a
 WHERE r.created_at < timestamptz '2026-11-23 20:28:53+00';

INSERT INTO public.driver_compliance_audit_log
  (driver_id, entity_type, entity_id, entity_label, action, changes, actor_user_id, actor_kind, actor_name, source, created_at)
SELECT r.driver_id, 'vehicle_change_request', r.id,
       btrim(concat_ws(' ', r.requested_year::text, r.requested_make, r.requested_model, '·', r.requested_license_plate)),
       'change_' || r.status,
       jsonb_strip_nulls(jsonb_build_object(
         'status', jsonb_build_object('from', 'pending', 'to', r.status),
         'rejection_reason', CASE WHEN r.rejection_reason IS NOT NULL THEN jsonb_build_object('from', null, 'to', r.rejection_reason) END)),
       r.reviewed_by, a.actor->>'kind', a.actor->>'name', 'backfill', r.reviewed_at
  FROM public.vehicle_change_requests r
  CROSS JOIN LATERAL (SELECT public.driver_compliance_audit_actor(r.reviewed_by) AS actor) a
 WHERE r.reviewed_at IS NOT NULL
   AND r.reviewed_at < timestamptz '2026-11-23 20:28:53+00'
   AND r.status IN ('approved', 'rejected');