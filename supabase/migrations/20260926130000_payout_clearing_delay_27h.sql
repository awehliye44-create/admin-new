-- PLATFORM_COLLECTED payout-clearing fallback: 48h → 27h.
-- Config only. Does not mutate customer payments, trip earnings, or payouts.

BEGIN;

UPDATE public.admin_settings
SET
  setting_value = '27'::jsonb,
  description = 'Backend-owned PLATFORM_COLLECTED payout-clearing fallback (hours). Used only when Revolut has not exposed a merchant-clearing event. Never a Driver-app timer.',
  updated_at = now()
WHERE setting_key = 'payout_clearing_delay_hours';

INSERT INTO public.admin_settings (setting_key, setting_value, description)
VALUES (
  'payout_clearing_delay_hours',
  '27'::jsonb,
  'Backend-owned PLATFORM_COLLECTED payout-clearing fallback (hours). Used only when Revolut has not exposed a merchant-clearing event. Never a Driver-app timer.'
)
ON CONFLICT (setting_key) DO UPDATE
SET
  setting_value = EXCLUDED.setting_value,
  description = EXCLUDED.description,
  updated_at = now();

CREATE OR REPLACE FUNCTION public.driver_wallet_payout_clearing_delay_hours()
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_raw jsonb;
  v_hours numeric;
BEGIN
  SELECT setting_value INTO v_raw
  FROM public.admin_settings
  WHERE setting_key = 'payout_clearing_delay_hours'
  LIMIT 1;

  IF v_raw IS NULL THEN
    RETURN 27;
  END IF;

  BEGIN
    IF jsonb_typeof(v_raw) = 'number' THEN
      v_hours := (v_raw #>> '{}')::numeric;
    ELSE
      v_hours := NULLIF(btrim(v_raw #>> '{}', '"'), '')::numeric;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RETURN 27;
  END;

  IF v_hours IS NULL OR v_hours < 0 THEN
    RETURN 27;
  END IF;
  RETURN v_hours;
END;
$$;

COMMIT;
