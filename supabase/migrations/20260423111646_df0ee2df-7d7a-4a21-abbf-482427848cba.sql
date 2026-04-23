-- Harden handle_new_user_profile: remove ability for signup metadata to grant admin/corporate roles.
-- Public signup may only result in 'customer' or 'driver' profile rows. Admin/corporate must be
-- assigned server-side (manual SQL or a Service-Role Edge Function), never from raw_user_meta_data.

CREATE OR REPLACE FUNCTION public.handle_new_user_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_app_type TEXT;
  v_role app_user_role;
  v_full_name TEXT;
BEGIN
  -- Read requested app_type but NEVER trust it for privileged roles.
  v_app_type := LOWER(COALESCE(NEW.raw_user_meta_data ->> 'app_type', 'customer'));

  -- Whitelist: only public, non-privileged roles are allowed from signup metadata.
  -- 'admin' and 'corporate' are deliberately excluded — any attempt to self-assign
  -- them via signup metadata is silently downgraded to 'customer'.
  IF v_app_type = 'driver' THEN
    v_role := 'driver';
  ELSE
    v_role := 'customer';
  END IF;

  v_full_name := COALESCE(TRIM(CONCAT(
    COALESCE(NEW.raw_user_meta_data ->> 'first_name', ''), ' ',
    COALESCE(NEW.raw_user_meta_data ->> 'last_name', '')
  )), '');

  INSERT INTO public.profiles (user_id, role, full_name, phone)
  VALUES (NEW.id, v_role, v_full_name, NEW.raw_user_meta_data ->> 'phone')
  ON CONFLICT (user_id) DO NOTHING;

  -- IMPORTANT: No INSERT into public.user_roles here.
  -- Admin role assignment must be performed exclusively by a privileged
  -- server-side flow (Service Role key) — for example, manually via the
  -- Supabase SQL editor:
  --   INSERT INTO public.user_roles (user_id, role) VALUES ('<uuid>', 'admin');
  -- This eliminates the privilege-escalation path from public signup.

  RETURN NEW;
END;
$function$;

-- Defense in depth: revoke any client-facing write access to user_roles.
-- (RLS already restricts it; this makes the intent explicit at the GRANT layer.)
REVOKE INSERT, UPDATE, DELETE ON public.user_roles FROM anon, authenticated;