-- Add all dispatch settings columns to the dispatch_settings table
ALTER TABLE public.dispatch_settings 
ADD COLUMN IF NOT EXISTS max_offers_per_request integer NOT NULL DEFAULT 5,
ADD COLUMN IF NOT EXISTS search_radius_meters integer NOT NULL DEFAULT 3000,
ADD COLUMN IF NOT EXISTS offer_expiry_seconds integer NOT NULL DEFAULT 20,
ADD COLUMN IF NOT EXISTS batch_mode text NOT NULL DEFAULT 'parallel',
ADD COLUMN IF NOT EXISTS minimum_rating numeric(2,1) NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS max_cancel_rate integer NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS cooldown_after_reject_seconds integer NOT NULL DEFAULT 180,
ADD COLUMN IF NOT EXISTS max_concurrent_offers_per_driver integer NOT NULL DEFAULT 1,
ADD COLUMN IF NOT EXISTS cascade_batch_size integer NOT NULL DEFAULT 3,
ADD COLUMN IF NOT EXISTS cascade_step_delay_seconds integer NOT NULL DEFAULT 8,
ADD COLUMN IF NOT EXISTS priority_order text NOT NULL DEFAULT 'nearest',
ADD COLUMN IF NOT EXISTS suppress_recent_offers_seconds integer NOT NULL DEFAULT 60,
ADD COLUMN IF NOT EXISTS stacked_rides_enabled boolean NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS max_stacked_rides integer NOT NULL DEFAULT 1,
ADD COLUMN IF NOT EXISTS stacked_search_radius_meters integer NOT NULL DEFAULT 2000,
ADD COLUMN IF NOT EXISTS stacked_min_trip_distance_km numeric(4,1) NOT NULL DEFAULT 3,
ADD COLUMN IF NOT EXISTS stacked_max_detour_minutes integer NOT NULL DEFAULT 10,
ADD COLUMN IF NOT EXISTS stacked_offer_window_minutes integer NOT NULL DEFAULT 5,
ADD COLUMN IF NOT EXISTS stacked_priority_mode text NOT NULL DEFAULT 'same_direction',
ADD COLUMN IF NOT EXISTS stacked_driver_incentive integer NOT NULL DEFAULT 5,
ADD COLUMN IF NOT EXISTS stacked_rider_discount integer NOT NULL DEFAULT 10,
ADD COLUMN IF NOT EXISTS stacked_show_eta_to_driver boolean NOT NULL DEFAULT true,
ADD COLUMN IF NOT EXISTS stacked_allow_rider_opt_out boolean NOT NULL DEFAULT true,
ADD COLUMN IF NOT EXISTS scheduled_rides_enabled boolean NOT NULL DEFAULT true,
ADD COLUMN IF NOT EXISTS min_advance_time_minutes integer NOT NULL DEFAULT 15,
ADD COLUMN IF NOT EXISTS max_advance_days integer NOT NULL DEFAULT 30,
ADD COLUMN IF NOT EXISTS waiting_time_grace_period_minutes integer NOT NULL DEFAULT 5,
ADD COLUMN IF NOT EXISTS scheduled_ride_incentives_enabled boolean NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS accept_timeout_seconds integer NOT NULL DEFAULT 12,
ADD COLUMN IF NOT EXISTS global_timeout_minutes integer NOT NULL DEFAULT 15,
ADD COLUMN IF NOT EXISTS max_offer_hops integer NOT NULL DEFAULT 10,
ADD COLUMN IF NOT EXISTS auto_retry_attempts integer NOT NULL DEFAULT 3,
ADD COLUMN IF NOT EXISTS auto_reassign_enabled boolean NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS instant_retry_enabled boolean NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS enable_logging boolean NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS simulate_mode boolean NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS block_multiple_active_rides boolean NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS cancel_protection boolean NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS driver_fare_display text NOT NULL DEFAULT 'net_earnings';

-- Add check constraints for valid values
ALTER TABLE public.dispatch_settings 
ADD CONSTRAINT batch_mode_check CHECK (batch_mode IN ('parallel', 'cascade')),
ADD CONSTRAINT priority_order_check CHECK (priority_order IN ('nearest', 'rating', 'acceptance', 'waiting')),
ADD CONSTRAINT stacked_priority_mode_check CHECK (stacked_priority_mode IN ('same_direction', 'nearest', 'highest_fare')),
ADD CONSTRAINT driver_fare_display_check CHECK (driver_fare_display IN ('net_earnings', 'full_breakdown'));

-- Add comment to table
COMMENT ON TABLE public.dispatch_settings IS 'Stores auto-dispatch configuration settings per service area or global';