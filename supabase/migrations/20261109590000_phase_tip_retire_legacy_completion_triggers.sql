-- Legacy completion triggers still owned tip money and the window stamp.
-- handle_tip_added inserted DRIVER_TIP_CREDIT on the claim, before capture,
-- and did not reverse it when the claim was reverted.
-- set_tip_window_on_completion opened a 2-minute window on every tips-enabled
-- completion, including channels that must capture immediately. That window
-- made finalize refuse the fare capture until expiry.
-- The edge stamp and the confirmed-capture ledger post own both.

CREATE OR REPLACE FUNCTION public.set_tip_window_on_completion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status = 'completed' AND (OLD.status IS DISTINCT FROM 'completed') THEN
    NEW.completed_at := COALESCE(NEW.completed_at, now());
  END IF;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.set_tip_window_on_completion() IS
  'Completion timestamp only. Tip window is stamped by the edge path for Customer App card trips.';

CREATE OR REPLACE FUNCTION public.handle_tip_added()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- Tip wallet credit is posted only after a confirmed capture covers fare+tip.
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.handle_tip_added() IS
  'No-op. DRIVER_TIP_CREDIT is posted by the confirmed-capture ledger path, never on the tip claim.';
