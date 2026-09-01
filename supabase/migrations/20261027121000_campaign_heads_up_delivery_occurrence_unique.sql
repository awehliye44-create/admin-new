-- Repeat campaigns must not upsert over the previous occurrence's delivery row.
-- Unique key is dedupe_key (includes occurrence instant for repeats).

ALTER TABLE public.campaign_heads_up_deliveries
  DROP CONSTRAINT IF EXISTS campaign_heads_up_deliveries_campaign_id_user_id_user_app_key;

CREATE UNIQUE INDEX IF NOT EXISTS campaign_heads_up_deliveries_dedupe_key_uidx
  ON public.campaign_heads_up_deliveries (dedupe_key);
