ALTER TABLE public.driver_active_devices
  DROP COLUMN IF EXISTS client_capabilities,
  DROP COLUMN IF EXISTS app_version,
  DROP COLUMN IF EXISTS client_capabilities_updated_at;

ALTER TABLE public.global_dispatch_settings
  DROP COLUMN IF EXISTS scheduled_departure_ack_min_app_version,
  DROP COLUMN IF EXISTS scheduled_departure_ack_capability_key;
