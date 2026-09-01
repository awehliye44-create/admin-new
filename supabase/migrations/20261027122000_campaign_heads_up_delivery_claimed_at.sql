-- Delivery claim timestamp so concurrent / retry workers can reclaim stale pending
-- without stealing an in-flight send.

ALTER TABLE public.campaign_heads_up_deliveries
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz;

UPDATE public.campaign_heads_up_deliveries
SET claimed_at = coalesce(claimed_at, created_at)
WHERE claimed_at IS NULL;
