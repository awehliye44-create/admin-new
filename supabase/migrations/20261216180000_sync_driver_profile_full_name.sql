-- HISTORY PARITY ONLY. Already applied on linked production.
-- Restored so local migration list matches remote. Do not re-apply via db push.
-- Keep profiles.full_name in step with the driver's name on public.drivers.
--
-- Admin "Edit driver" writes drivers.first_name/last_name only, while the Driver
-- Wallet Ledger and Financial Reconciliation identity resolver prefers
-- profiles.full_name. A corrected driver name (MK0006, 2026-10-13) therefore kept
-- showing the old name. Syncing in the database covers every write path, and the
-- Admin client cannot do it reliably because profiles UPDATE RLS is admin-role only.

CREATE OR REPLACE FUNCTION public.sync_driver_profile_full_name()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_full_name text;
BEGIN
  v_full_name := nullif(btrim(concat_ws(' ',
    nullif(btrim(NEW.first_name), ''),
    nullif(btrim(NEW.last_name), '')
  )), '');

  -- A blanked name must not wipe the profile name.
  IF v_full_name IS NULL OR NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;

  UPDATE public.profiles p
  SET full_name = v_full_name
  WHERE p.user_id = NEW.user_id
    AND p.role = 'driver'
    AND p.full_name IS DISTINCT FROM v_full_name;

  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.sync_driver_profile_full_name() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sync_driver_profile_full_name() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sync_driver_profile_full_name() FROM anon;
REVOKE ALL ON FUNCTION public.sync_driver_profile_full_name() FROM authenticated;

DROP TRIGGER IF EXISTS trg_sync_driver_profile_full_name ON public.drivers;
CREATE TRIGGER trg_sync_driver_profile_full_name
AFTER UPDATE OF first_name, last_name ON public.drivers
FOR EACH ROW
WHEN (
  OLD.first_name IS DISTINCT FROM NEW.first_name
  OR OLD.last_name IS DISTINCT FROM NEW.last_name
)
EXECUTE FUNCTION public.sync_driver_profile_full_name();
