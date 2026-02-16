
-- Add countdown configuration to preset_offer_configs
ALTER TABLE public.preset_offer_configs
  ADD COLUMN countdown_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN countdown_seconds INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN countdown_auto_select BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN countdown_auto_select_offer_id TEXT DEFAULT NULL;

-- Add comment for documentation
COMMENT ON COLUMN public.preset_offer_configs.countdown_enabled IS 'Whether to show a countdown timer on preset offer selection';
COMMENT ON COLUMN public.preset_offer_configs.countdown_seconds IS 'Duration of the countdown in seconds';
COMMENT ON COLUMN public.preset_offer_configs.countdown_auto_select IS 'Auto-select an offer when countdown expires';
COMMENT ON COLUMN public.preset_offer_configs.countdown_auto_select_offer_id IS 'Offer key to auto-select on countdown expiry (defaults to default_selected_offer_id)';
