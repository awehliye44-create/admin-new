ALTER TABLE public.corporate_accounts ADD COLUMN IF NOT EXISTS archived_at timestamptz, ADD COLUMN IF NOT EXISTS archived_by uuid;
ALTER TABLE public.corporate_account_requests ADD COLUMN IF NOT EXISTS archived_at timestamptz, ADD COLUMN IF NOT EXISTS archived_by uuid;

CREATE OR REPLACE FUNCTION public.admin_remove_corporate_account(p_account_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_trips int; v_invoices int; v_open int;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' AND NOT public.staff_has_page_access('corporate-accounts') THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM corporate_accounts WHERE id = p_account_id) THEN
    RAISE EXCEPTION 'Account not found';
  END IF;
  SELECT count(*) INTO v_open FROM trips WHERE corporate_account_id = p_account_id
    AND upper(status::text) NOT IN ('COMPLETED','CANCELLED','NO_SHOW','LATE_PASSENGER_CANCELLATION','EXPIRED','FAILED','ARRIVAL_CANCELLATION');
  IF v_open > 0 THEN
    RAISE EXCEPTION 'CORPORATE_ACCOUNT_HAS_OPEN_TRIPS: % trip(s) still in progress', v_open;
  END IF;
  SELECT count(*) INTO v_trips FROM trips WHERE corporate_account_id = p_account_id;
  SELECT count(*) INTO v_invoices FROM corporate_invoices WHERE corporate_account_id = p_account_id;
  IF v_trips > 0 OR v_invoices > 0 THEN
    UPDATE corporate_accounts SET status = 'suspended', archived_at = now(), archived_by = auth.uid() WHERE id = p_account_id;
    RETURN jsonb_build_object('outcome','archived','trips',v_trips,'invoices',v_invoices);
  END IF;
  DELETE FROM corporate_schedule_holds WHERE corporate_account_id = p_account_id;
  DELETE FROM corporate_accounts WHERE id = p_account_id;
  RETURN jsonb_build_object('outcome','deleted');
END $$;

CREATE OR REPLACE FUNCTION public.admin_restore_corporate_account(p_account_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' AND NOT public.staff_has_page_access('corporate-accounts') THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  UPDATE corporate_accounts SET archived_at = NULL, archived_by = NULL WHERE id = p_account_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Account not found'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.admin_remove_corporate_request(p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_status text;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' AND NOT public.staff_has_page_access('account-requests') THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  SELECT status INTO v_status FROM corporate_account_requests WHERE id = p_request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF v_status = 'approved' THEN
    UPDATE corporate_account_requests SET archived_at = now(), archived_by = auth.uid() WHERE id = p_request_id;
    RETURN jsonb_build_object('outcome','archived');
  END IF;
  DELETE FROM corporate_account_requests WHERE id = p_request_id;
  RETURN jsonb_build_object('outcome','deleted');
END $$;

CREATE OR REPLACE FUNCTION public.admin_restore_corporate_request(p_request_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' AND NOT public.staff_has_page_access('account-requests') THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  UPDATE corporate_account_requests SET archived_at = NULL, archived_by = NULL WHERE id = p_request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
END $$;

REVOKE ALL ON FUNCTION public.admin_remove_corporate_account(uuid), public.admin_restore_corporate_account(uuid), public.admin_remove_corporate_request(uuid), public.admin_restore_corporate_request(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_remove_corporate_account(uuid), public.admin_restore_corporate_account(uuid), public.admin_remove_corporate_request(uuid), public.admin_restore_corporate_request(uuid) TO authenticated, service_role;