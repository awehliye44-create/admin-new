
-- 1. Auto-grant admin role for admin@onecab.net on signup, and grant immediately if already present
CREATE OR REPLACE FUNCTION public.grant_admin_for_designated_emails()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.email = 'admin@onecab.net' THEN
    INSERT INTO public.user_roles (user_id, role)
    VALUES (NEW.id, 'admin')
    ON CONFLICT (user_id, role) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created_grant_admin ON auth.users;
CREATE TRIGGER on_auth_user_created_grant_admin
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.grant_admin_for_designated_emails();

-- Backfill if account already exists
INSERT INTO public.user_roles (user_id, role)
SELECT id, 'admin'::app_role FROM auth.users WHERE email = 'admin@onecab.net'
ON CONFLICT (user_id, role) DO NOTHING;

-- 2. Prevent suspending an admin account (any admin), and especially self-suspension
CREATE OR REPLACE FUNCTION public.prevent_admin_suspension()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Block any suspension targeting a user who holds the admin role
  IF EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = NEW.user_id AND role = 'admin') THEN
    RAISE EXCEPTION 'You cannot suspend or block an admin account.'
      USING ERRCODE = '42501';
  END IF;
  -- Extra explicit self-protection
  IF NEW.user_id = auth.uid() THEN
    RAISE EXCEPTION 'You cannot suspend or block your own admin account.'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS prevent_admin_suspension_trg ON public.account_suspensions;
CREATE TRIGGER prevent_admin_suspension_trg
  BEFORE INSERT OR UPDATE ON public.account_suspensions
  FOR EACH ROW EXECUTE FUNCTION public.prevent_admin_suspension();

-- 3. Prevent admin from removing/altering their own admin role
CREATE OR REPLACE FUNCTION public.prevent_self_admin_role_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target_user uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_user := OLD.user_id;
    IF OLD.role = 'admin' AND target_user = auth.uid() THEN
      RAISE EXCEPTION 'You cannot remove admin access from your own account.'
        USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  ELSE
    target_user := NEW.user_id;
    IF TG_OP = 'UPDATE' AND OLD.role = 'admin' AND NEW.role <> 'admin' AND target_user = auth.uid() THEN
      RAISE EXCEPTION 'You cannot change your own admin role.'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS prevent_self_admin_role_change_trg ON public.user_roles;
CREATE TRIGGER prevent_self_admin_role_change_trg
  BEFORE UPDATE OR DELETE ON public.user_roles
  FOR EACH ROW EXECUTE FUNCTION public.prevent_self_admin_role_change();
