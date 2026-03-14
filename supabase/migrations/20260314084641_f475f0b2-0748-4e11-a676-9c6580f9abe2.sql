
ALTER TABLE public.dispatch_settings
  ADD COLUMN IF NOT EXISTS scheduled_response_window_minutes integer NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS urgent_dispatch_trigger_minutes_before_pickup integer NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS locked_driver_response_minutes integer NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS scheduled_urgent_card_label text NOT NULL DEFAULT 'Scheduled • Urgent',
  ADD COLUMN IF NOT EXISTS enable_scheduled_to_urgent_conversion boolean NOT NULL DEFAULT true;
