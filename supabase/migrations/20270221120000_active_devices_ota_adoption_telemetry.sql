-- OTA adoption telemetry on the sole active Driver / Customer device.
-- Written by bind-driver-device-token and save-customer-push-token on every bind.
-- Nullable: older apps do not send these fields. Missing body → NULL (cleared, never merged).
-- NOT for production until explicit review + Edge deploy of both bind functions.
-- Telemetry only: never used to force or gate an OTA reload.

ALTER TABLE public.driver_active_devices
  ADD COLUMN IF NOT EXISTS loaded_update_id text,
  ADD COLUMN IF NOT EXISTS update_is_embedded boolean,
  ADD COLUMN IF NOT EXISTS runtime_version text,
  ADD COLUMN IF NOT EXISTS loaded_update_registered_at timestamptz;

ALTER TABLE public.customer_active_devices
  ADD COLUMN IF NOT EXISTS loaded_update_id text,
  ADD COLUMN IF NOT EXISTS update_is_embedded boolean,
  ADD COLUMN IF NOT EXISTS runtime_version text,
  ADD COLUMN IF NOT EXISTS loaded_update_registered_at timestamptz;

COMMENT ON COLUMN public.driver_active_devices.loaded_update_id IS
  'Expo Updates.updateId of the update currently LOADED and running on this installation (not the downloaded/available update).';
COMMENT ON COLUMN public.driver_active_devices.update_is_embedded IS
  'true when the running JS is the embedded (store binary) bundle; false when launched from an OTA update.';
COMMENT ON COLUMN public.driver_active_devices.runtime_version IS
  'Expo runtimeVersion reported by the active Driver installation.';
COMMENT ON COLUMN public.driver_active_devices.loaded_update_registered_at IS
  'When loaded_update_id / update_is_embedded / runtime_version were last successfully registered by a bind.';

COMMENT ON COLUMN public.customer_active_devices.loaded_update_id IS
  'Expo Updates.updateId of the update currently LOADED and running on this installation (not the downloaded/available update).';
COMMENT ON COLUMN public.customer_active_devices.update_is_embedded IS
  'true when the running JS is the embedded (store binary) bundle; false when launched from an OTA update.';
COMMENT ON COLUMN public.customer_active_devices.runtime_version IS
  'Expo runtimeVersion reported by the active Customer installation.';
COMMENT ON COLUMN public.customer_active_devices.loaded_update_registered_at IS
  'When loaded_update_id / update_is_embedded / runtime_version were last successfully registered by a bind.';
