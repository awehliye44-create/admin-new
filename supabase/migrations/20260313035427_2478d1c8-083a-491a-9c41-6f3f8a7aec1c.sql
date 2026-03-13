-- Remove legacy commission_override_pct column from drivers table
-- Tier commission in driver_categories is now the single source of truth
ALTER TABLE public.drivers DROP COLUMN IF EXISTS commission_override_pct;