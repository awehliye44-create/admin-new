DROP TRIGGER IF EXISTS on_auth_user_created_grant_admin ON auth.users;
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tgname FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
           WHERE t.tgrelid = 'auth.users'::regclass AND p.proname = 'grant_admin_for_designated_emails'
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON auth.users', r.tgname);
  END LOOP;
END $$;
DROP FUNCTION IF EXISTS public.grant_admin_for_designated_emails();