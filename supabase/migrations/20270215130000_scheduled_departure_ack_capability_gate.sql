-- Phase 5 capability gate: per-device departure-ack support beyond the global flag.
-- NOT for production until staging verification + explicit approval.
-- Older Driver builds without the capability continue on Phase 4 exclusive NRO.

ALTER TABLE public.global_dispatch_settings
  ADD COLUMN IF NOT EXISTS scheduled_departure_ack_min_app_version text,
  ADD COLUMN IF NOT EXISTS scheduled_departure_ack_capability_key text NOT NULL DEFAULT 'scheduled_departure_ack_v1';

COMMENT ON COLUMN public.global_dispatch_settings.scheduled_departure_ack_min_app_version IS
  'Optional semver floor for Phase 5 departure ack. Null = no version floor (capability key alone).';
COMMENT ON COLUMN public.global_dispatch_settings.scheduled_departure_ack_capability_key IS
  'Capability token Driver must advertise on active-device bind (default scheduled_departure_ack_v1).';

ALTER TABLE public.driver_active_devices
  ADD COLUMN IF NOT EXISTS client_capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS app_version text,
  ADD COLUMN IF NOT EXISTS client_capabilities_updated_at timestamptz;

COMMENT ON COLUMN public.driver_active_devices.client_capabilities IS
  'JSON array of capability strings reported by the active Driver installation (e.g. scheduled_departure_ack_v1).';
COMMENT ON COLUMN public.driver_active_devices.app_version IS
  'Last reported Driver app_version from bind / capability heartbeat.';

UPDATE public.global_dispatch_settings
SET
  scheduled_departure_ack_enabled = false,
  scheduled_departure_ack_capability_key = COALESCE(
    scheduled_departure_ack_capability_key,
    'scheduled_departure_ack_v1'
  ),
  jit_auto_activate_enabled = false
WHERE singleton = true;
