CREATE OR REPLACE FUNCTION public.approve_corporate_request(p_request_id uuid, p_reviewed_by uuid DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_request RECORD;
  v_account_id uuid;
BEGIN
  SELECT * INTO v_request FROM corporate_account_requests WHERE id = p_request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF v_request.status = 'approved' THEN RAISE EXCEPTION 'Request already approved'; END IF;
  
  INSERT INTO corporate_accounts (
    company_name, contact_name, contact_email, contact_phone,
    address, city, country, tax_id, employee_count, notes,
    region_id, service_area_id, status
  ) VALUES (
    v_request.company_name, v_request.contact_name, v_request.contact_email, v_request.contact_phone,
    v_request.address, v_request.city, v_request.country, v_request.tax_id,
    v_request.employee_count, v_request.notes,
    v_request.region_id, v_request.service_area_id, 'active'
  ) RETURNING id INTO v_account_id;
  
  UPDATE corporate_account_requests
  SET status = 'approved', approved_at = now(), reviewed_at = now(),
      reviewed_by = p_reviewed_by, updated_at = now()
  WHERE id = p_request_id;
  
  RETURN v_account_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.suspend_corporate_request(p_request_id uuid, p_reviewed_by uuid DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  UPDATE corporate_account_requests
  SET status = 'suspended', suspended_at = now(), reviewed_at = now(),
      reviewed_by = p_reviewed_by, updated_at = now()
  WHERE id = p_request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
END;
$$;