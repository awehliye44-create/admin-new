REVOKE ALL ON FUNCTION public.set_corporate_account_service_area(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_corporate_account_service_area(uuid, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.validate_service_area_reference() FROM PUBLIC, anon, authenticated;;
