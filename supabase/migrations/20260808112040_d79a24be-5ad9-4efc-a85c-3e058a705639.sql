-- Global VoIP + per-service-area Call Masking SSOT

-- 1. Normalise legacy rows so no stored value can disable VoIP.
UPDATE public.service_area_communication_settings
SET voip_enabled = true,
    is_enabled = true,
    updated_at = now()
WHERE voip_enabled IS DISTINCT FROM true OR is_enabled IS DISTINCT FROM true;

ALTER TABLE public.service_area_communication_settings
  ALTER COLUMN voip_enabled SET DEFAULT true,
  ALTER COLUMN is_enabled SET DEFAULT true;

COMMENT ON COLUMN public.service_area_communication_settings.voip_enabled IS
  'DEPRECATED - no runtime authority. VoIP is globally always enabled.';
COMMENT ON COLUMN public.service_area_communication_settings.is_enabled IS
  'DEPRECATED - no runtime authority. Communication module is always active.';
COMMENT ON COLUMN public.service_area_communication_settings.default_method IS
  'DEPRECATED - no runtime authority. VoIP and Call Masking are user-selected, no default/fallback.';

-- 2. Keep deprecated flags pinned true on any future write.
CREATE OR REPLACE FUNCTION public.force_global_voip_communication()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.voip_enabled := true;
  NEW.is_enabled := true;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_force_global_voip_communication ON public.service_area_communication_settings;
CREATE TRIGGER trg_force_global_voip_communication
BEFORE INSERT OR UPDATE ON public.service_area_communication_settings
FOR EACH ROW EXECUTE FUNCTION public.force_global_voip_communication();

-- 3. Authoritative resolver: VoIP global-always-on, masking per service area.
CREATE OR REPLACE FUNCTION public.resolve_service_area_communication(_service_area_id UUID)
RETURNS TABLE (
  service_area_id UUID,
  voip_available BOOLEAN,
  voip_provider TEXT,
  call_masking_available BOOLEAN,
  masked_outbound_caller_id TEXT,
  maximum_call_duration_seconds INTEGER
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    _service_area_id,
    true AS voip_available,
    'livekit'::text AS voip_provider,
    COALESCE(s.call_masking_enabled, false) AND COALESCE(m.is_active, false) AS call_masking_available,
    CASE
      WHEN COALESCE(s.call_masking_enabled, false) AND COALESCE(m.is_active, false)
        THEN m.outbound_caller_id
      ELSE NULL
    END AS masked_outbound_caller_id,
    COALESCE(s.maximum_call_duration_seconds, 600) AS maximum_call_duration_seconds
  FROM (SELECT 1) AS anchor
  LEFT JOIN public.service_area_communication_settings s
    ON s.service_area_id = _service_area_id
  LEFT JOIN public.service_area_call_masking_config m
    ON m.service_area_id = _service_area_id;
$$;

REVOKE ALL ON FUNCTION public.resolve_service_area_communication(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_service_area_communication(UUID) TO authenticated, service_role;