-- Customer Home restriction banner must flip immediately when Admin
-- suspends/disables/enables. customers was not in supabase_realtime, so the
-- app only noticed on a slow poll. Publish the table; filter by primary key id.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'customers'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.customers;
  END IF;
END $$;

COMMIT;
