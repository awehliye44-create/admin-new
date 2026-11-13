SET client_min_messages = warning;
-- LOCAL / CI ONLY. Minimal stand-ins for the GoTrue-managed `auth` objects the public schema
-- references (the plain supabase/postgres image ships a bare auth.users and no auth.jwt()).
-- GoTrue itself is not started in the PG harness job.
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb
  LANGUAGE sql STABLE AS $$
  select coalesce(nullif(current_setting('request.jwt.claim', true), ''),
                  nullif(current_setting('request.jwt.claims', true), ''))::jsonb $$;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS instance_id uuid;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS id uuid;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS aud varchar;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS role varchar;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email varchar;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS encrypted_password varchar;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email_confirmed_at timestamptz;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS invited_at timestamptz;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS confirmation_token varchar;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS confirmation_sent_at timestamptz;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS recovery_token varchar;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS recovery_sent_at timestamptz;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email_change_token_new varchar;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email_change varchar;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email_change_sent_at timestamptz;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS last_sign_in_at timestamptz;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS raw_app_meta_data jsonb;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS raw_user_meta_data jsonb;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS is_super_admin boolean;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS created_at timestamptz;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS updated_at timestamptz;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS phone_confirmed_at timestamptz;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS phone_change text;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS phone_change_token varchar;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS phone_change_sent_at timestamptz;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email_change_token_current varchar;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email_change_confirm_status smallint;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS reauthentication_token varchar;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS reauthentication_sent_at timestamptz;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS is_sso_user boolean;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS is_anonymous boolean;
