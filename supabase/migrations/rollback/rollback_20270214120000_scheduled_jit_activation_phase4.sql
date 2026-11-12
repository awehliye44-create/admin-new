-- Rollback Phase 4 JIT columns. Does not restore activated trips.
DROP INDEX IF EXISTS public.idx_trips_scheduled_jit_activate_due;

ALTER TABLE public.trips
  DROP COLUMN IF EXISTS scheduled_jit_activate_at,
  DROP COLUMN IF EXISTS scheduled_jit_eta_minutes,
  DROP COLUMN IF EXISTS scheduled_jit_eta_observed_at,
  DROP COLUMN IF EXISTS scheduled_jit_distance_kind,
  DROP COLUMN IF EXISTS scheduled_jit_eta_source,
  DROP COLUMN IF EXISTS scheduled_jit_basis_scheduled_at,
  DROP COLUMN IF EXISTS scheduled_jit_activated_at,
  DROP COLUMN IF EXISTS scheduled_jit_activation_source;

ALTER TABLE public.global_dispatch_settings
  DROP COLUMN IF EXISTS jit_target_early_arrival_minutes,
  DROP COLUMN IF EXISTS jit_local_safety_buffer_minutes,
  DROP COLUMN IF EXISTS jit_long_safety_buffer_minutes,
  DROP COLUMN IF EXISTS jit_long_distance_eta_threshold_minutes,
  DROP COLUMN IF EXISTS jit_oscillation_tolerance_minutes,
  DROP COLUMN IF EXISTS jit_planning_horizon_minutes,
  DROP COLUMN IF EXISTS jit_max_early_pull_ahead_of_fixed_minutes,
  DROP COLUMN IF EXISTS jit_auto_activate_enabled;
