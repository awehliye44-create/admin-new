-- Service Area Communication SSOT (admin-configured VoIP + call masking assignment)

CREATE TYPE public.communication_default_method AS ENUM ('voip', 'call_masking');

-- Read-only catalog of existing call-masking provider configs (integration unchanged).
CREATE TABLE public.call_masking_provider_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  country_code TEXT NOT NULL,
  number_pool_id TEXT NOT NULL,
  outbound_caller_id TEXT NOT NULL,
  label TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.call_masking_provider_configs (provider, country_code, number_pool_id, outbound_caller_id, label)
VALUES
  ('msg91', 'GB', 'uk-default-pool', '+441234567890', 'MSG91 UK — default pool'),
  ('msg91', 'GB', 'uk-mk-pool', '+441908000000', 'MSG91 UK — Milton Keynes pool');

CREATE TABLE public.service_area_communication_settings (
  service_area_id UUID PRIMARY KEY REFERENCES public.service_areas(id) ON DELETE CASCADE,
  voip_enabled BOOLEAN NOT NULL DEFAULT false,
  call_masking_enabled BOOLEAN NOT NULL DEFAULT false,
  default_method public.communication_default_method NOT NULL DEFAULT 'voip',
  maximum_call_duration_seconds INTEGER NOT NULL DEFAULT 600 CHECK (maximum_call_duration_seconds > 0),
  voip_rate_per_minute_minor INTEGER NOT NULL DEFAULT 0 CHECK (voip_rate_per_minute_minor >= 0),
  masked_call_rate_per_minute_minor INTEGER NOT NULL DEFAULT 0 CHECK (masked_call_rate_per_minute_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'GBP',
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  voip_provider TEXT NOT NULL DEFAULT 'livekit',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.service_area_call_masking_config (
  service_area_id UUID PRIMARY KEY REFERENCES public.service_areas(id) ON DELETE CASCADE,
  provider_config_id UUID REFERENCES public.call_masking_provider_configs(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  country_code TEXT NOT NULL,
  number_pool_id TEXT NOT NULL,
  outbound_caller_id TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.voip_call_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_area_id UUID REFERENCES public.service_areas(id) ON DELETE SET NULL,
  trip_id UUID REFERENCES public.trips(id) ON DELETE SET NULL,
  driver_id UUID,
  customer_id UUID,
  status TEXT NOT NULL DEFAULT 'completed',
  duration_seconds INTEGER CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  end_reason TEXT,
  provider TEXT NOT NULL DEFAULT 'livekit',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_voip_call_logs_service_area ON public.voip_call_logs (service_area_id, started_at DESC);
CREATE INDEX idx_voip_call_logs_trip ON public.voip_call_logs (trip_id);

ALTER TABLE public.call_masking_provider_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_area_communication_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_area_call_masking_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.voip_call_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Call masking provider configs readable by authenticated"
  ON public.call_masking_provider_configs FOR SELECT TO authenticated USING (true);

CREATE POLICY "Call masking provider configs managed by admin"
  ON public.call_masking_provider_configs FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Service area communication settings readable by authenticated"
  ON public.service_area_communication_settings FOR SELECT TO authenticated USING (true);

CREATE POLICY "Service area communication settings managed by admin"
  ON public.service_area_communication_settings FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Service area call masking config readable by authenticated"
  ON public.service_area_call_masking_config FOR SELECT TO authenticated USING (true);

CREATE POLICY "Service area call masking config managed by admin"
  ON public.service_area_call_masking_config FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "VoIP call logs readable by admin"
  ON public.voip_call_logs FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "VoIP call logs managed by service role"
  ON public.voip_call_logs FOR ALL TO service_role USING (true) WITH CHECK (true);

GRANT SELECT ON public.voip_call_logs TO authenticated;
GRANT ALL ON public.voip_call_logs TO service_role;

CREATE POLICY "Admins read call masking call logs"
  ON public.call_masking_call_logs FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins read call masking sessions"
  ON public.call_masking_sessions FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

GRANT SELECT ON public.call_masking_call_logs TO authenticated;
GRANT SELECT ON public.call_masking_sessions TO authenticated;
