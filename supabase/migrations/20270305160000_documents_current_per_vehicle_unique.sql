-- Vehicle-scoped documents may be current on more than one vehicle for the same
-- driver+type. The legacy uniq_documents_driver_type_current + demote trigger
-- collapsed all vehicles to a single current row, so restoring an original
-- vehicle demoted the replacement's current docs (and vice versa).
-- Do not apply to production until authenticated verification. Contracts verified:false.

BEGIN;

DROP INDEX IF EXISTS public.uniq_documents_driver_type_current;

-- One current row per driver + type + vehicle (vehicle-linked).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_documents_driver_vehicle_type_current
  ON public.documents (driver_id, document_type, vehicle_id)
  WHERE is_current = true AND vehicle_id IS NOT NULL;

-- One current row per driver + type when not linked to a vehicle (driver-level).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_documents_driver_type_current_no_vehicle
  ON public.documents (driver_id, document_type)
  WHERE is_current = true AND vehicle_id IS NULL;

CREATE OR REPLACE FUNCTION public.trg_documents_demote_current_before()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.driver_id IS NULL OR NEW.document_type IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.driver_id = NEW.driver_id
     AND OLD.document_type = NEW.document_type
     AND OLD.vehicle_id IS NOT DISTINCT FROM NEW.vehicle_id
     AND OLD.is_current = NEW.is_current THEN
    RETURN NEW;
  END IF;

  IF NEW.is_current = true THEN
    IF public.is_vehicle_scoped_document_slug(NEW.document_type)
       AND NEW.vehicle_id IS NOT NULL THEN
      -- Demote only siblings for the same vehicle.
      UPDATE public.documents
         SET is_current = false,
             updated_at = now()
       WHERE driver_id = NEW.driver_id
         AND document_type = NEW.document_type
         AND vehicle_id IS NOT DISTINCT FROM NEW.vehicle_id
         AND id IS DISTINCT FROM NEW.id
         AND is_current = true;
    ELSE
      -- Driver-level (or unscoped) docs: demote other driver-level currents only.
      UPDATE public.documents
         SET is_current = false,
             updated_at = now()
       WHERE driver_id = NEW.driver_id
         AND document_type = NEW.document_type
         AND vehicle_id IS NULL
         AND id IS DISTINCT FROM NEW.id
         AND is_current = true;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMIT;
