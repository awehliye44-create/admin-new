-- Digital-only finance SSOT: retire operational cash workflows; keep historical rows readable.

-- Ensure finance era is digital (idempotent).
INSERT INTO public.admin_settings (setting_key, setting_value, description)
VALUES ('finance_era', to_jsonb('digital'::text), 'Active finance era — digital-only')
ON CONFLICT (setting_key) DO UPDATE
SET setting_value = EXCLUDED.setting_value,
    description = EXCLUDED.description,
    updated_at = now();

-- Drivers no longer accept cash trips.
UPDATE public.driver_settings SET accept_cash = false WHERE accept_cash IS TRUE;

ALTER TABLE public.driver_settings
  ALTER COLUMN accept_cash SET DEFAULT false;

-- No-op legacy cash completion RPC (historical audit rows remain).
CREATE OR REPLACE FUNCTION public.record_cash_trip_completion(
  p_trip_id uuid,
  p_driver_id uuid,
  p_currency text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'Cash trip completion is no longer supported. ONECAB is digital-only.'
    USING ERRCODE = 'check_violation';
END;
$$;

COMMENT ON FUNCTION public.record_cash_trip_completion IS
  'Deprecated — digital-only platform. Historical cash trips are audit-read-only.';
