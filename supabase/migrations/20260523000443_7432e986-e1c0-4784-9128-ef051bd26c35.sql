
-- Add missing dispatch columns to global_dispatch_settings (singleton)
ALTER TABLE public.global_dispatch_settings
  ADD COLUMN IF NOT EXISTS shortlist_limit integer NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS wave1_size integer NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS wave2_size integer NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS wave3_size integer NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS wave1_offer_expiry_seconds integer NOT NULL DEFAULT 25,
  ADD COLUMN IF NOT EXISTS wave2_offer_expiry_seconds integer NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS wave3_offer_expiry_seconds integer NOT NULL DEFAULT 35,
  ADD COLUMN IF NOT EXISTS offer_expiry_seconds integer NOT NULL DEFAULT 40,
  ADD COLUMN IF NOT EXISTS accept_timeout_seconds integer NOT NULL DEFAULT 25,
  ADD COLUMN IF NOT EXISTS distance_penalty_per_meter numeric NOT NULL DEFAULT 0.002,
  ADD COLUMN IF NOT EXISTS waiting_bonus_per_minute numeric NOT NULL DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS max_waiting_bonus_minutes integer NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS fairness_idle_minutes integer NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS fairness_boost_score integer NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS max_driver_find_time_minutes integer NOT NULL DEFAULT 3,
  -- Stacked rides (meters everywhere)
  ADD COLUMN IF NOT EXISTS stacked_search_radius_meters integer NOT NULL DEFAULT 2000,
  ADD COLUMN IF NOT EXISTS stacked_min_trip_distance_meters integer NOT NULL DEFAULT 3000,
  ADD COLUMN IF NOT EXISTS stacked_max_detour_minutes integer NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS stacked_offer_window_minutes integer NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS stacked_priority_mode text NOT NULL DEFAULT 'same_direction',
  ADD COLUMN IF NOT EXISTS stacked_driver_incentive numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stacked_rider_discount numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stacked_show_eta_to_driver boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS stacked_allow_rider_opt_out boolean NOT NULL DEFAULT true,
  -- Scheduled rides
  ADD COLUMN IF NOT EXISTS scheduled_rides_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS min_advance_time_minutes integer NOT NULL DEFAULT 15,
  ADD COLUMN IF NOT EXISTS max_advance_days integer NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS waiting_time_grace_period_minutes integer NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS scheduled_ride_incentives_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS scheduled_response_window_minutes integer NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS urgent_dispatch_trigger_minutes_before_pickup integer NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS locked_driver_response_minutes integer NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS scheduled_urgent_card_label text NOT NULL DEFAULT 'Scheduled • Urgent',
  ADD COLUMN IF NOT EXISTS enable_scheduled_to_urgent_conversion boolean NOT NULL DEFAULT true,
  -- System flags
  ADD COLUMN IF NOT EXISTS enable_logging boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS simulate_mode boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS block_multiple_active_rides boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS cancel_protection boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS driver_fare_display text NOT NULL DEFAULT 'smart_display',
  -- Stacked min stacked_rides count (alias of max_active_rides_per_driver - 1, kept for backend usage)
  ADD COLUMN IF NOT EXISTS max_stacked_rides integer NOT NULL DEFAULT 1;

-- Backfill from existing global dispatch_settings row (service_area_id IS NULL), converting km→meters
UPDATE public.global_dispatch_settings g
SET
  shortlist_limit                 = COALESCE(d.shortlist_limit, g.shortlist_limit),
  wave1_size                      = COALESCE(d.wave1_size, g.wave1_size),
  wave2_size                      = COALESCE(d.wave2_size, g.wave2_size),
  wave3_size                      = COALESCE(d.wave3_size, g.wave3_size),
  wave1_offer_expiry_seconds      = COALESCE(d.wave1_offer_expiry_seconds, g.wave1_offer_expiry_seconds),
  wave2_offer_expiry_seconds      = COALESCE(d.wave2_offer_expiry_seconds, g.wave2_offer_expiry_seconds),
  wave3_offer_expiry_seconds      = COALESCE(d.wave3_offer_expiry_seconds, g.wave3_offer_expiry_seconds),
  offer_expiry_seconds            = COALESCE(d.offer_expiry_seconds, g.offer_expiry_seconds),
  accept_timeout_seconds          = COALESCE(d.accept_timeout_seconds, g.accept_timeout_seconds),
  distance_penalty_per_meter      = COALESCE(d.distance_penalty_per_km / 1000.0, g.distance_penalty_per_meter),
  waiting_bonus_per_minute        = COALESCE(d.waiting_bonus_per_minute, g.waiting_bonus_per_minute),
  max_waiting_bonus_minutes       = COALESCE(d.max_waiting_bonus_minutes, g.max_waiting_bonus_minutes),
  fairness_idle_minutes           = COALESCE(d.fairness_idle_minutes, g.fairness_idle_minutes),
  fairness_boost_score            = COALESCE(d.fairness_boost_score, g.fairness_boost_score),
  max_driver_find_time_minutes    = COALESCE(d.max_driver_find_time_minutes, g.max_driver_find_time_minutes),
  -- Radii (km → m) — only overwrite if present
  start_radius_meters             = COALESCE(ROUND(d.search_radius_start_km * 1000)::int, g.start_radius_meters),
  expand_radius_meters            = COALESCE(ROUND(d.search_radius_expand_km * 1000)::int, g.expand_radius_meters),
  max_radius_meters               = COALESCE(ROUND(d.search_radius_max_km * 1000)::int, g.max_radius_meters),
  -- Stacked
  stacked_search_radius_meters    = COALESCE(d.stacked_search_radius_meters, g.stacked_search_radius_meters),
  stacked_min_trip_distance_meters= COALESCE(ROUND(d.stacked_min_trip_distance_km * 1000)::int, g.stacked_min_trip_distance_meters),
  stacked_max_detour_minutes      = COALESCE(d.stacked_max_detour_minutes, g.stacked_max_detour_minutes),
  stacked_offer_window_minutes    = COALESCE(d.stacked_offer_window_minutes, g.stacked_offer_window_minutes),
  stacked_priority_mode           = COALESCE(d.stacked_priority_mode, g.stacked_priority_mode),
  stacked_driver_incentive        = COALESCE(d.stacked_driver_incentive, g.stacked_driver_incentive),
  stacked_rider_discount          = COALESCE(d.stacked_rider_discount, g.stacked_rider_discount),
  stacked_show_eta_to_driver      = COALESCE(d.stacked_show_eta_to_driver, g.stacked_show_eta_to_driver),
  stacked_allow_rider_opt_out     = COALESCE(d.stacked_allow_rider_opt_out, g.stacked_allow_rider_opt_out),
  stacked_rides_enabled           = COALESCE(d.stacked_rides_enabled, g.stacked_rides_enabled),
  max_stacked_rides               = COALESCE(d.max_stacked_rides, g.max_stacked_rides),
  max_active_rides_per_driver     = COALESCE(d.max_stacked_rides + 1, g.max_active_rides_per_driver),
  -- Scheduled
  scheduled_rides_enabled         = COALESCE(d.scheduled_rides_enabled, g.scheduled_rides_enabled),
  min_advance_time_minutes        = COALESCE(d.min_advance_time_minutes, g.min_advance_time_minutes),
  max_advance_days                = COALESCE(d.max_advance_days, g.max_advance_days),
  waiting_time_grace_period_minutes = COALESCE(d.waiting_time_grace_period_minutes, g.waiting_time_grace_period_minutes),
  scheduled_ride_incentives_enabled = COALESCE(d.scheduled_ride_incentives_enabled, g.scheduled_ride_incentives_enabled),
  scheduled_response_window_minutes = COALESCE(d.scheduled_response_window_minutes, g.scheduled_response_window_minutes),
  urgent_dispatch_trigger_minutes_before_pickup = COALESCE(d.urgent_dispatch_trigger_minutes_before_pickup, g.urgent_dispatch_trigger_minutes_before_pickup),
  locked_driver_response_minutes  = COALESCE(d.locked_driver_response_minutes, g.locked_driver_response_minutes),
  scheduled_urgent_card_label     = COALESCE(d.scheduled_urgent_card_label, g.scheduled_urgent_card_label),
  enable_scheduled_to_urgent_conversion = COALESCE(d.enable_scheduled_to_urgent_conversion, g.enable_scheduled_to_urgent_conversion),
  -- System
  enable_logging                  = COALESCE(d.enable_logging, g.enable_logging),
  simulate_mode                   = COALESCE(d.simulate_mode, g.simulate_mode),
  block_multiple_active_rides     = COALESCE(d.block_multiple_active_rides, g.block_multiple_active_rides),
  cancel_protection               = COALESCE(d.cancel_protection, g.cancel_protection),
  driver_fare_display             = COALESCE(d.driver_fare_display, g.driver_fare_display),
  updated_at                      = now()
FROM (SELECT * FROM public.dispatch_settings WHERE service_area_id IS NULL LIMIT 1) d
WHERE g.singleton = true;

-- Ensure singleton row exists
INSERT INTO public.global_dispatch_settings (singleton)
SELECT true
WHERE NOT EXISTS (SELECT 1 FROM public.global_dispatch_settings WHERE singleton = true);
