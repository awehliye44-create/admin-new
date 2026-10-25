-- Restore the pre-20261109590000 completion triggers.
-- These reopen the unpaid tip credit and the 2-minute window. Do not apply unless rolling back.

CREATE OR REPLACE FUNCTION public.set_tip_window_on_completion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_tips_enabled boolean := false;
BEGIN
  IF NEW.status = 'completed' AND (OLD.status IS DISTINCT FROM 'completed') THEN
    NEW.completed_at := COALESCE(NEW.completed_at, now());

    IF NEW.service_area_id IS NOT NULL THEN
      SELECT COALESCE(sa.tips_enabled, false)
      INTO v_tips_enabled
      FROM public.service_areas sa
      WHERE sa.id = NEW.service_area_id;
    END IF;

    IF v_tips_enabled THEN
      NEW.tip_window_expires_at := NEW.completed_at + interval '2 minutes';
    ELSE
      NEW.tip_window_expires_at := NEW.completed_at;
      NEW.tip_window_closed_at := COALESCE(NEW.tip_window_closed_at, NEW.completed_at);
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.handle_tip_added()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_tip_diff integer;
BEGIN
  IF NEW.status != 'completed' THEN
    RETURN NEW;
  END IF;

  v_tip_diff := COALESCE(NEW.tip_amount_pence, 0) - COALESCE(OLD.tip_amount_pence, 0);

  IF v_tip_diff = 0 THEN
    RETURN NEW;
  END IF;

  NEW.driver_net_before_tip_pence := COALESCE(NEW.driver_net_pence, 0);
  NEW.driver_total_earnings_pence := COALESCE(NEW.driver_net_pence, 0) + COALESCE(NEW.tip_amount_pence, 0);

  IF v_tip_diff > 0 AND NEW.driver_id IS NOT NULL THEN
    INSERT INTO public.driver_wallet_ledger (
      driver_id,
      related_trip_id,
      type,
      amount_pence,
      currency,
      description
    ) VALUES (
      NEW.driver_id,
      NEW.id,
      'DRIVER_TIP_CREDIT',
      v_tip_diff,
      'GBP',
      'Tip from passenger (£' || (v_tip_diff / 100.0)::text || ')'
    );
  END IF;

  RETURN NEW;
END;
$function$;
