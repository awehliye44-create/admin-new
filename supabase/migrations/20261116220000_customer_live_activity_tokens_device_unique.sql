-- MK-261116-011: one Live Activity token row per customer device.
-- UNIQUE (customer_user_id, device_id, trip_id) broke upserts when trip_id was NULL
-- (Postgres treats NULLs as distinct), so ActivityKit tokens never persisted and
-- APNs updates could not fan out after local Activity start.

ALTER TABLE public.customer_live_activity_tokens
  DROP CONSTRAINT IF EXISTS customer_live_activity_tokens_customer_user_id_device_id_trip_id_key;
ALTER TABLE public.customer_live_activity_tokens
  DROP CONSTRAINT IF EXISTS customer_live_activity_tokens_customer_user_id_device_id_tr_key;

DROP INDEX IF EXISTS public.customer_live_activity_tokens_customer_user_id_device_id_trip_id_key;
DROP INDEX IF EXISTS public.customer_live_activity_tokens_customer_user_id_device_id_tr_key;

CREATE UNIQUE INDEX IF NOT EXISTS customer_live_activity_tokens_device_uidx
  ON public.customer_live_activity_tokens (customer_user_id, device_id);

COMMENT ON INDEX public.customer_live_activity_tokens_device_uidx IS
  'One authoritative ActivityKit token row per customer installation; trip_id is metadata.';
