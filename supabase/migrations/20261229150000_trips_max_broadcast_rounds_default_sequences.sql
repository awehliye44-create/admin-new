-- Unify trips.max_broadcast_rounds with instant book SSOT:
-- absolute sequences = Admin Max Dispatch Rounds × 3 (default 3 × 3 = 9).
-- Column DEFAULT was 3 (cycles mistaken for sequences), which capped converted
-- scheduled trips after early marketplace offers and stopped waves before the
-- find-driver search window (typically 6 minutes) ended.

ALTER TABLE public.trips
  ALTER COLUMN max_broadcast_rounds SET DEFAULT 9;

COMMENT ON COLUMN public.trips.max_broadcast_rounds IS
  'Absolute dispatch sequences (Admin max_dispatch_rounds × 3). Default 9 = 3 W1→W2→W3 cycles.';
