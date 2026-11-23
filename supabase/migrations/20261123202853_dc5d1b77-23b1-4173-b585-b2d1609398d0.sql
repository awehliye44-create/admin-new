-- 1) Vehicles: a rejection reason only belongs to a rejected vehicle (single DB rule for every writer)
CREATE OR REPLACE FUNCTION public.vehicles_clear_stale_rejection_reason()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.approval_status IS DISTINCT FROM 'rejected' THEN
    NEW.rejection_reason := NULL;
  END IF;
  RETURN NEW;
END;
$$;

-- Repair existing stale reasons before audit capture starts (lock triggers bypassed only for this one-off repair)
ALTER TABLE public.vehicles DISABLE TRIGGER enforce_vehicle_approval_lock;
ALTER TABLE public.vehicles DISABLE TRIGGER check_vehicle_edit_allowed_trigger;
UPDATE public.vehicles
   SET rejection_reason = NULL
 WHERE approval_status IS DISTINCT FROM 'rejected'
   AND rejection_reason IS NOT NULL;
ALTER TABLE public.vehicles ENABLE TRIGGER enforce_vehicle_approval_lock;
ALTER TABLE public.vehicles ENABLE TRIGGER check_vehicle_edit_allowed_trigger;

DROP TRIGGER IF EXISTS vehicles_clear_stale_rejection_reason ON public.vehicles;
CREATE TRIGGER vehicles_clear_stale_rejection_reason
  BEFORE INSERT OR UPDATE ON public.vehicles
  FOR EACH ROW EXECUTE FUNCTION public.vehicles_clear_stale_rejection_reason();

-- 2) Immutable audit trail for driver documents, vehicles and vehicle change requests
CREATE TABLE public.driver_compliance_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  entity_label text,
  action text NOT NULL,
  changes jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_user_id uuid,
  actor_kind text NOT NULL,
  actor_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.driver_compliance_audit_log TO authenticated;
GRANT ALL ON public.driver_compliance_audit_log TO service_role;

ALTER TABLE public.driver_compliance_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Driver/vehicle/document staff can view compliance audit"
  ON public.driver_compliance_audit_log FOR SELECT TO authenticated
  USING (public.staff_has_any_page_access(ARRAY['drivers','vehicles','documents']));

CREATE INDEX driver_compliance_audit_log_driver_idx
  ON public.driver_compliance_audit_log (driver_id, created_at DESC);
CREATE INDEX driver_compliance_audit_log_entity_idx
  ON public.driver_compliance_audit_log (entity_type, entity_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.driver_compliance_audit_block_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  RAISE EXCEPTION 'driver_compliance_audit_log is append-only' USING ERRCODE = '42501';
END;
$$;

CREATE TRIGGER driver_compliance_audit_log_immutable
  BEFORE UPDATE OR DELETE ON public.driver_compliance_audit_log
  FOR EACH ROW EXECUTE FUNCTION public.driver_compliance_audit_block_mutation();

CREATE OR REPLACE FUNCTION public.driver_compliance_audit_actor(p_uid uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_name text;
BEGIN
  IF p_uid IS NULL THEN
    RETURN jsonb_build_object('kind', 'system', 'name', 'System');
  END IF;
  SELECT COALESCE(NULLIF(btrim(sp.full_name), ''), NULLIF(btrim(sp.username), ''), 'Staff')
    INTO v_name FROM public.staff_profiles sp WHERE sp.user_id = p_uid LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('kind', 'staff', 'name', v_name);
  END IF;
  IF public.has_role(p_uid, 'admin'::app_role) THEN
    RETURN jsonb_build_object('kind', 'admin', 'name', 'Admin');
  END IF;
  SELECT NULLIF(btrim(COALESCE(d.first_name, '') || ' ' || COALESCE(d.last_name, '')), '')
    INTO v_name FROM public.drivers d WHERE d.user_id = p_uid LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('kind', 'driver', 'name', COALESCE(v_name, 'Driver'));
  END IF;
  RETURN jsonb_build_object('kind', 'user', 'name', 'User');
END;
$$;

CREATE OR REPLACE FUNCTION public.driver_compliance_audit_diff(p_old jsonb, p_new jsonb, p_keys text[])
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$
  SELECT COALESCE(
    jsonb_object_agg(k, jsonb_build_object('from', p_old -> k, 'to', p_new -> k)),
    '{}'::jsonb)
  FROM unnest(p_keys) AS k
  WHERE COALESCE(p_old -> k, 'null'::jsonb) IS DISTINCT FROM COALESCE(p_new -> k, 'null'::jsonb);
$$;

REVOKE EXECUTE ON FUNCTION public.driver_compliance_audit_actor(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.driver_compliance_audit_diff(jsonb, jsonb, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.driver_compliance_audit_actor(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.driver_compliance_audit_diff(jsonb, jsonb, text[]) TO service_role;

-- Documents
CREATE OR REPLACE FUNCTION public.trg_documents_compliance_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_row public.documents%ROWTYPE;
  v_changes jsonb;
  v_action text;
  v_uid uuid;
  v_actor jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN v_row := OLD; ELSE v_row := NEW; END IF;

  v_changes := public.driver_compliance_audit_diff(
    CASE WHEN TG_OP = 'INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END,
    CASE WHEN TG_OP = 'DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END,
    ARRAY['status','expiry_date','rejection_reason','notes','document_type','document_name','is_current']);

  IF TG_OP = 'UPDATE' AND OLD.file_url IS DISTINCT FROM NEW.file_url THEN
    v_changes := v_changes || jsonb_build_object('file', jsonb_build_object('from', 'previous file', 'to', 'new file'));
  END IF;

  IF TG_OP = 'UPDATE' AND v_changes = '{}'::jsonb THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_action := 'uploaded';
  ELSIF TG_OP = 'DELETE' THEN
    v_action := 'deleted';
  ELSIF OLD.status IS DISTINCT FROM NEW.status THEN
    v_action := CASE NEW.status
      WHEN 'approved' THEN 'approved'
      WHEN 'rejected' THEN 'rejected'
      WHEN 'pending' THEN 'set_pending'
      WHEN 'expired' THEN 'expired'
      ELSE 'status_changed' END;
  ELSIF NEW.status = 'rejected' AND OLD.rejection_reason IS DISTINCT FROM NEW.rejection_reason THEN
    v_action := 're_rejected';
  ELSIF OLD.is_current IS DISTINCT FROM NEW.is_current AND NEW.is_current = false THEN
    v_action := 'superseded';
  ELSIF OLD.expiry_date IS DISTINCT FROM NEW.expiry_date THEN
    v_action := 'expiry_changed';
  ELSE
    v_action := 'updated';
  END IF;

  v_uid := COALESCE(
    auth.uid(),
    CASE WHEN TG_OP = 'UPDATE' AND (OLD.status IS DISTINCT FROM NEW.status OR OLD.rejection_reason IS DISTINCT FROM NEW.rejection_reason) THEN NEW.reviewed_by END,
    CASE WHEN TG_OP = 'INSERT' THEN NEW.uploaded_by END);
  v_actor := public.driver_compliance_audit_actor(v_uid);

  INSERT INTO public.driver_compliance_audit_log
    (driver_id, entity_type, entity_id, entity_label, action, changes, actor_user_id, actor_kind, actor_name)
  VALUES
    (v_row.driver_id, 'document', v_row.id,
     COALESCE(NULLIF(btrim(v_row.document_name), ''), v_row.document_type),
     v_action, v_changes, v_uid, v_actor->>'kind', v_actor->>'name');
  RETURN NULL;
END;
$$;

CREATE TRIGGER documents_compliance_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.trg_documents_compliance_audit();

-- Vehicles
CREATE OR REPLACE FUNCTION public.trg_vehicles_compliance_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_row public.vehicles%ROWTYPE;
  v_changes jsonb;
  v_action text;
  v_uid uuid := auth.uid();
  v_actor jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN v_row := OLD; ELSE v_row := NEW; END IF;

  v_changes := public.driver_compliance_audit_diff(
    CASE WHEN TG_OP = 'INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END,
    CASE WHEN TG_OP = 'DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END,
    ARRAY['make','model','year','color','license_plate','is_primary','approval_status','rejection_reason','capacity','vehicle_type_id','driver_id']);

  IF TG_OP = 'UPDATE' AND v_changes = '{}'::jsonb THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_action := 'added';
  ELSIF TG_OP = 'DELETE' THEN
    v_action := 'deleted';
  ELSIF OLD.approval_status IS DISTINCT FROM NEW.approval_status THEN
    v_action := CASE NEW.approval_status
      WHEN 'approved' THEN 'approved'
      WHEN 'rejected' THEN 'rejected'
      WHEN 'pending' THEN 'set_pending'
      ELSE 'status_changed' END;
  ELSIF NEW.approval_status = 'rejected' AND OLD.rejection_reason IS DISTINCT FROM NEW.rejection_reason THEN
    v_action := 're_rejected';
  ELSIF OLD.driver_id IS DISTINCT FROM NEW.driver_id AND NEW.driver_id IS NULL THEN
    v_action := 'unassigned';
  ELSE
    v_action := 'updated';
  END IF;

  v_actor := public.driver_compliance_audit_actor(v_uid);

  INSERT INTO public.driver_compliance_audit_log
    (driver_id, entity_type, entity_id, entity_label, action, changes, actor_user_id, actor_kind, actor_name)
  VALUES
    (COALESCE(v_row.driver_id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.driver_id END),
     'vehicle', v_row.id,
     btrim(concat_ws(' ', v_row.year::text, v_row.make, v_row.model, '·', v_row.license_plate)),
     v_action, v_changes, v_uid, v_actor->>'kind', v_actor->>'name');
  RETURN NULL;
END;
$$;

CREATE TRIGGER vehicles_compliance_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.vehicles
  FOR EACH ROW EXECUTE FUNCTION public.trg_vehicles_compliance_audit();

-- Vehicle change requests
CREATE OR REPLACE FUNCTION public.trg_vehicle_change_requests_compliance_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_changes jsonb;
  v_action text;
  v_uid uuid;
  v_actor jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_changes := public.driver_compliance_audit_diff(
      jsonb_build_object('make', NEW.previous_make, 'model', NEW.previous_model, 'year', NEW.previous_year,
                         'color', NEW.previous_color, 'license_plate', NEW.previous_license_plate),
      jsonb_build_object('make', NEW.requested_make, 'model', NEW.requested_model, 'year', NEW.requested_year,
                         'color', NEW.requested_color, 'license_plate', NEW.requested_license_plate),
      ARRAY['make','model','year','color','license_plate']);
    v_action := 'change_requested';
    v_uid := auth.uid();
  ELSE
    v_changes := public.driver_compliance_audit_diff(to_jsonb(OLD), to_jsonb(NEW),
      ARRAY['status','rejection_reason','admin_notes']);
    IF v_changes = '{}'::jsonb THEN
      RETURN NULL;
    END IF;
    v_action := CASE
      WHEN OLD.status IS DISTINCT FROM NEW.status THEN 'change_' || COALESCE(NEW.status, 'updated')
      ELSE 'change_updated' END;
    v_uid := COALESCE(auth.uid(), NEW.reviewed_by);
  END IF;

  v_actor := public.driver_compliance_audit_actor(v_uid);

  INSERT INTO public.driver_compliance_audit_log
    (driver_id, entity_type, entity_id, entity_label, action, changes, actor_user_id, actor_kind, actor_name)
  VALUES
    (NEW.driver_id, 'vehicle_change_request', NEW.id,
     btrim(concat_ws(' ', NEW.requested_year::text, NEW.requested_make, NEW.requested_model, '·', NEW.requested_license_plate)),
     v_action, v_changes, v_uid, v_actor->>'kind', v_actor->>'name');
  RETURN NULL;
END;
$$;

CREATE TRIGGER vehicle_change_requests_compliance_audit
  AFTER INSERT OR UPDATE ON public.vehicle_change_requests
  FOR EACH ROW EXECUTE FUNCTION public.trg_vehicle_change_requests_compliance_audit();

REVOKE EXECUTE ON FUNCTION public.trg_documents_compliance_audit() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.trg_vehicles_compliance_audit() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.trg_vehicle_change_requests_compliance_audit() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.vehicles_clear_stale_rejection_reason() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.driver_compliance_audit_block_mutation() FROM PUBLIC, anon, authenticated;