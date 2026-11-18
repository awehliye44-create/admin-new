-- LOCAL / CI ONLY. The plain supabase/postgres image used by pg-harness has no
-- Storage API schema. The public baseline dump also omits it, so any
-- post-baseline migration that creates policies on storage.objects fails with
-- "relation storage.objects does not exist".
-- Production already has storage.objects and storage.foldername. This stub
-- exists only so those migrations can be applied here unchanged.
CREATE SCHEMA IF NOT EXISTS storage;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id text,
  name text,
  owner uuid,
  created_at timestamptz,
  updated_at timestamptz,
  last_accessed_at timestamptz,
  metadata jsonb,
  version text,
  owner_id text,
  user_metadata jsonb
);

CREATE OR REPLACE FUNCTION storage.foldername(name text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN name IS NULL THEN NULL
    ELSE (string_to_array(name, '/'))[1:GREATEST(coalesce(array_length(string_to_array(name, '/'), 1), 1) - 1, 0)]
  END
$$;
