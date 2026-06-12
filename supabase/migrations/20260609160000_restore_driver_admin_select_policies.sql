-- Restore driver RLS policies needed for admin invoice UI joins and driver self-access.
-- Migration 20260423110011 removed driver self-read without recreating admin read policies
-- in this repo's migration history.

DROP POLICY IF EXISTS "Admins can read all drivers" ON public.drivers;
CREATE POLICY "Admins can read all drivers"
  ON public.drivers
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role));

DROP POLICY IF EXISTS "Admins can update all drivers" ON public.drivers;
CREATE POLICY "Admins can update all drivers"
  ON public.drivers
  FOR UPDATE
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));

DROP POLICY IF EXISTS "Drivers can read own profile" ON public.drivers;
CREATE POLICY "Drivers can read own profile"
  ON public.drivers
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can create own driver profile" ON public.drivers;
CREATE POLICY "Users can create own driver profile"
  ON public.drivers
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS driver_display_name text,
  ADD COLUMN IF NOT EXISTS driver_display_code text;

UPDATE public.invoices i
SET
  driver_display_name = NULLIF(trim(concat(d.first_name, ' ', d.last_name)), ''),
  driver_display_code = d.driver_code
FROM public.drivers d
WHERE i.driver_id = d.id
  AND (i.driver_display_name IS NULL OR trim(i.driver_display_name) = '');

UPDATE public.invoices i
SET driver_display_name = COALESCE(p.full_name, i.driver_display_name)
FROM public.drivers d
JOIN public.profiles p ON p.user_id = d.user_id
WHERE i.driver_id = d.id
  AND (i.driver_display_name IS NULL OR trim(i.driver_display_name) = '')
  AND NULLIF(trim(p.full_name), '') IS NOT NULL;

-- Recover driver_id from legacy PDF paths when the driver row still exists.
UPDATE public.invoices i
SET driver_id = d.id
FROM public.drivers d
WHERE i.driver_id IS NULL
  AND i.pdf_storage_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
  AND d.id = split_part(i.pdf_storage_path, '/', 1)::uuid;
