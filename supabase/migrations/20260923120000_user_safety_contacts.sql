-- User-managed emergency / safety contacts.
-- Shared across Customer and Driver apps via auth.users.id.
-- Personal data: owner-only RLS. No admin/other-user access.
-- Never used by trip, dispatch, chat, share-trip, or call-masking.

CREATE TABLE IF NOT EXISTS public.user_safety_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  contact_name text NOT NULL,
  phone_number text NOT NULL,
  contact_type text NOT NULL CHECK (
    contact_type IN ('emergency', 'police', 'family', 'friend', 'other')
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_safety_contacts_name_not_blank CHECK (length(btrim(contact_name)) > 0),
  CONSTRAINT user_safety_contacts_phone_not_blank CHECK (length(btrim(phone_number)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_user_safety_contacts_user_id
  ON public.user_safety_contacts (user_id);

CREATE OR REPLACE FUNCTION public.set_user_safety_contacts_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_user_safety_contacts_updated_at ON public.user_safety_contacts;
CREATE TRIGGER trg_user_safety_contacts_updated_at
  BEFORE UPDATE ON public.user_safety_contacts
  FOR EACH ROW
  EXECUTE FUNCTION public.set_user_safety_contacts_updated_at();

CREATE OR REPLACE FUNCTION public.enforce_user_safety_contacts_cap()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n
  FROM public.user_safety_contacts
  WHERE user_id = NEW.user_id;
  IF n >= 10 THEN
    RAISE EXCEPTION 'user_safety_contacts_cap_exceeded';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_user_safety_contacts_cap ON public.user_safety_contacts;
CREATE TRIGGER trg_user_safety_contacts_cap
  BEFORE INSERT ON public.user_safety_contacts
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_user_safety_contacts_cap();

ALTER TABLE public.user_safety_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_safety_contacts FORCE ROW LEVEL SECURITY;

CREATE POLICY "Users select own safety contacts"
  ON public.user_safety_contacts FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users insert own safety contacts"
  ON public.user_safety_contacts FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users update own safety contacts"
  ON public.user_safety_contacts FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users delete own safety contacts"
  ON public.user_safety_contacts FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

REVOKE ALL ON TABLE public.user_safety_contacts FROM PUBLIC;
REVOKE ALL ON TABLE public.user_safety_contacts FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_safety_contacts TO authenticated;

COMMENT ON TABLE public.user_safety_contacts IS
  'User-owned emergency/safety contacts. Owner-only RLS via auth.uid(). Personal data only.';
