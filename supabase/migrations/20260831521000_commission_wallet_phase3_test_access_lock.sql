-- P0 Phase 3 — lock commission_wallet_test_access against driver self-grant.
-- Drivers may update own profile via RLS; this column is admin/service_role only.

CREATE OR REPLACE FUNCTION public.prevent_driver_self_grant_commission_wallet_test_access()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF COALESCE(NEW.commission_wallet_test_access, false) IS NOT TRUE THEN
      RETURN NEW;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.commission_wallet_test_access IS NOT DISTINCT FROM NEW.commission_wallet_test_access THEN
      RETURN NEW;
    END IF;
  ELSE
    RETURN NEW;
  END IF;

  -- Service-role clients (admin edges / SQL via service key).
  IF auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  -- Explicit session flag (optional gated admin RPC/edge path).
  IF current_setting('onecab.commission_wallet_test_access_admin', true) = '1' THEN
    RETURN NEW;
  END IF;

  -- Legacy JWT admin role.
  IF auth.uid() IS NOT NULL
     AND public.has_role(auth.uid(), 'admin'::public.app_role) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'commission_wallet_test_access_admin_only'
    USING ERRCODE = 'check_violation',
          HINT = 'Only admins may grant or revoke Commission Wallet test access.';
END;
$$;

DROP TRIGGER IF EXISTS tr_prevent_driver_self_grant_cw_test_access ON public.drivers;
CREATE TRIGGER tr_prevent_driver_self_grant_cw_test_access
  BEFORE INSERT OR UPDATE OF commission_wallet_test_access ON public.drivers
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_driver_self_grant_commission_wallet_test_access();

COMMENT ON FUNCTION public.prevent_driver_self_grant_commission_wallet_test_access() IS
  'Phase 3: block drivers from self-granting commission_wallet_test_access; allow service_role and admin role.';
