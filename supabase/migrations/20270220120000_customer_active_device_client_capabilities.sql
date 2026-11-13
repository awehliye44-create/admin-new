-- Customer OTA capability advertisement on the sole active device.
-- Bind (save-customer-push-token) always replaces client_capabilities.
-- Missing / empty body → [] (clears previously registered capabilities).
-- NOT for production until explicit review + Edge deploy of save-customer-push-token.

ALTER TABLE public.customer_active_devices
  ADD COLUMN IF NOT EXISTS client_capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS app_version text,
  ADD COLUMN IF NOT EXISTS client_capabilities_updated_at timestamptz;

COMMENT ON COLUMN public.customer_active_devices.client_capabilities IS
  'JSON array of capability strings reported by the active Customer installation (loaded OTA / embedded JS). Always replaced on bind — never merged.';
COMMENT ON COLUMN public.customer_active_devices.app_version IS
  'Last reported Customer app_version from save-customer-push-token bind.';
COMMENT ON COLUMN public.customer_active_devices.client_capabilities_updated_at IS
  'When client_capabilities was last replaced by an authoritative Customer bind.';
