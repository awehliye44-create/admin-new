-- Restore customer profiles wiped from public.customers.
-- Only rider accounts (not driver app_type) with both auth email + phone confirmed.

DO $$
DECLARE
  v_user record;
  v_customer_id uuid;
BEGIN
  FOR v_user IN
    SELECT u.id
    FROM auth.users u
    WHERE u.deleted_at IS NULL
      AND u.email_confirmed_at IS NOT NULL
      AND u.phone_confirmed_at IS NOT NULL
      AND coalesce(u.raw_user_meta_data ->> 'app_type', '') <> 'driver'
      AND NOT EXISTS (
        SELECT 1 FROM public.user_roles ur
        WHERE ur.user_id = u.id AND ur.role = 'admin'
      )
  LOOP
    BEGIN
      v_customer_id := public.finalize_customer_onboarding(v_user.id);
      RAISE NOTICE 'Restored customer % for user %', v_customer_id, v_user.id;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Skipped user %: %', v_user.id, SQLERRM;
    END;
  END LOOP;
END $$;
