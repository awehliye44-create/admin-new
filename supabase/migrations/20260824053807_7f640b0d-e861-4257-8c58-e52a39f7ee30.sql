-- 1. Allow anonymous visitors (corporate signup) to read active service areas
CREATE POLICY "Anyone can read active service areas"
ON public.service_areas
FOR SELECT
TO anon
USING (is_active = true);

-- 2. Validate service_area_id exists and is active
CREATE OR REPLACE FUNCTION public.validate_service_area_reference()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.service_area_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.service_areas
      WHERE id = NEW.service_area_id AND is_active = true
    ) THEN
      RAISE EXCEPTION 'Invalid or inactive service area: %', NEW.service_area_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_service_area_on_corporate_accounts ON public.corporate_accounts;
CREATE TRIGGER validate_service_area_on_corporate_accounts
BEFORE INSERT OR UPDATE OF service_area_id ON public.corporate_accounts
FOR EACH ROW EXECUTE FUNCTION public.validate_service_area_reference();

DROP TRIGGER IF EXISTS validate_service_area_on_corporate_requests ON public.corporate_account_requests;
CREATE TRIGGER validate_service_area_on_corporate_requests
BEFORE INSERT OR UPDATE OF service_area_id ON public.corporate_account_requests
FOR EACH ROW EXECUTE FUNCTION public.validate_service_area_reference();

-- 3. Corporate admin can set their own account's service area when missing
CREATE OR REPLACE FUNCTION public.set_corporate_account_service_area(
  p_corporate_account_id uuid,
  p_service_area_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.corporate_user_accounts
    WHERE user_id = auth.uid()
      AND corporate_account_id = p_corporate_account_id
      AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'Not authorised for this corporate account';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.service_areas
    WHERE id = p_service_area_id AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Invalid or inactive service area';
  END IF;

  SELECT service_area_id INTO v_existing
  FROM public.corporate_accounts WHERE id = p_corporate_account_id;

  IF v_existing IS NOT NULL THEN
    RAISE EXCEPTION 'Service area already set for this account';
  END IF;

  UPDATE public.corporate_accounts
  SET service_area_id = p_service_area_id
  WHERE id = p_corporate_account_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_corporate_account_service_area(uuid, uuid) TO authenticated;;
