ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS driver_display_email text;

UPDATE public.invoices i
SET
  driver_display_email = d.email,
  driver_display_name = COALESCE(NULLIF(trim(i.driver_display_name), ''), NULLIF(trim(concat(d.first_name, ' ', d.last_name)), '')),
  driver_display_code = COALESCE(i.driver_display_code, d.driver_code)
FROM public.drivers d
WHERE i.driver_id = d.id
  AND (i.driver_display_email IS NULL OR trim(i.driver_display_email) = '');

-- Snapshot email/name for orphaned invoices when the region has exactly one active driver.
UPDATE public.invoices i
SET
  driver_display_name = NULLIF(trim(concat(d.first_name, ' ', d.last_name)), ''),
  driver_display_code = d.driver_code,
  driver_display_email = d.email
FROM public.drivers d
WHERE i.driver_id IS NULL
  AND i.region_id = d.region_id
  AND d.driver_status = 'active'
  AND (
    SELECT COUNT(*)
    FROM public.drivers active
    WHERE active.region_id = i.region_id
      AND active.driver_status = 'active'
  ) = 1;
