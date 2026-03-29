-- Enforce region_id as NOT NULL on invoices (region is mandatory)
ALTER TABLE public.invoices ALTER COLUMN region_id SET NOT NULL;

-- Enforce region_id as NOT NULL on statement_runs
ALTER TABLE public.statement_runs ALTER COLUMN region_id SET NOT NULL;

-- Add foreign keys if missing
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'invoices_region_id_fkey' AND table_name = 'invoices'
  ) THEN
    ALTER TABLE public.invoices
      ADD CONSTRAINT invoices_region_id_fkey FOREIGN KEY (region_id) REFERENCES public.regions(id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'invoices_service_area_id_fkey' AND table_name = 'invoices'
  ) THEN
    ALTER TABLE public.invoices
      ADD CONSTRAINT invoices_service_area_id_fkey FOREIGN KEY (service_area_id) REFERENCES public.service_areas(id);
  END IF;
END $$;

-- Trigger to validate that invoice currency_code matches the region currency_code
CREATE OR REPLACE FUNCTION public.validate_invoice_currency()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
DECLARE
  v_region_currency text;
BEGIN
  SELECT currency_code INTO v_region_currency
  FROM public.regions
  WHERE id = NEW.region_id;

  IF v_region_currency IS NULL THEN
    RAISE EXCEPTION 'Region % has no currency configured', NEW.region_id;
  END IF;

  IF NEW.currency_code != v_region_currency THEN
    RAISE EXCEPTION 'Invoice currency_code (%) does not match region currency_code (%). Mixed currencies are not allowed.',
      NEW.currency_code, v_region_currency;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_validate_invoice_currency ON public.invoices;
CREATE TRIGGER trg_validate_invoice_currency
  BEFORE INSERT OR UPDATE ON public.invoices
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_invoice_currency();

-- Add RLS policy for drivers to view their own invoices
CREATE POLICY "Drivers can view own invoices"
  ON public.invoices
  FOR SELECT
  TO authenticated
  USING (driver_id = public.current_driver_id());

-- Add RLS for drivers to view own invoice items
CREATE POLICY "Drivers can view own invoice items"
  ON public.invoice_items
  FOR SELECT
  TO authenticated
  USING (
    invoice_id IN (
      SELECT id FROM public.invoices WHERE driver_id = public.current_driver_id()
    )
  );
