
-- Add schedule fields to preset_offer_configs
ALTER TABLE public.preset_offer_configs
  ADD COLUMN IF NOT EXISTS schedule_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS schedule_days integer[] NOT NULL DEFAULT '{1,2,3,4,5,6,7}',
  ADD COLUMN IF NOT EXISTS schedule_start_time text NOT NULL DEFAULT '08:00',
  ADD COLUMN IF NOT EXISTS schedule_end_time text NOT NULL DEFAULT '22:00';

COMMENT ON COLUMN public.preset_offer_configs.schedule_enabled IS 'When true, offers are only available within the scheduled window';
COMMENT ON COLUMN public.preset_offer_configs.schedule_days IS 'Days of week when offers are allowed (1=Mon..7=Sun)';
COMMENT ON COLUMN public.preset_offer_configs.schedule_start_time IS 'Start time in HH:mm format (local to service area timezone)';
COMMENT ON COLUMN public.preset_offer_configs.schedule_end_time IS 'End time in HH:mm format (local to service area timezone)';
