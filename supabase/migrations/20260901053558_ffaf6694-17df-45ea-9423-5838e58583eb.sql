DO $$
DECLARE
  tbl text;
  targets text[] := ARRAY['drivers','vehicles','driver_service_areas','driver_categories'];
  has_priv boolean;
BEGIN
  FOREACH tbl IN ARRAY targets LOOP
    SELECT EXISTS (
      SELECT 1 FROM information_schema.role_table_grants
      WHERE grantee='authenticated' AND table_schema='public' AND table_name=tbl
        AND privilege_type='SELECT'
    ) INTO has_priv;
    IF NOT has_priv THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', tbl);
    END IF;

    SELECT EXISTS (
      SELECT 1 FROM information_schema.role_table_grants
      WHERE grantee='service_role' AND table_schema='public' AND table_name=tbl
        AND privilege_type='SELECT'
    ) INTO has_priv;
    IF NOT has_priv THEN
      EXECUTE format('GRANT ALL ON public.%I TO service_role', tbl);
    END IF;
  END LOOP;
END $$;