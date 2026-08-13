-- Single-device delivery invariant: at most one selectable Driver push token per account.
-- Soft-deactivate siblings first in bind-driver-device-token; this index catches races.
CREATE UNIQUE INDEX IF NOT EXISTS push_tokens_one_active_per_driver_uidx
  ON public.push_tokens (driver_id)
  WHERE is_active = true
    AND app_type = 'driver'
    AND token IS NOT NULL
    AND length(token) > 0;

-- Customer: at most one push token row per user (claim/bind wipe siblings).
CREATE UNIQUE INDEX IF NOT EXISTS customer_push_tokens_one_per_user_uidx
  ON public.customer_push_tokens (user_id);
