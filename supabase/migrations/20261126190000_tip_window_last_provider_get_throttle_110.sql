-- #110 P4D: throttle UNKNOWN/PROCESSING CLAIM_HELD provider GET reconcile.
-- Steal eligibility remains tip_window_claimed_at + 5 minutes; this column only
-- bounds re-GET frequency so a 5s expiry sweep cannot hammer Revolut while the
-- claim is retained. AUTHORISED/COMPLETED settle on the next allowed GET.

ALTER TABLE public.trips
  ADD COLUMN IF NOT EXISTS tip_window_last_provider_get_at timestamptz;

COMMENT ON COLUMN public.trips.tip_window_last_provider_get_at IS
  '#110 P4D: last Revolut GET during CLAIM_HELD stale tip-window reclaim. '
  'Throttle UNKNOWN/PROCESSING re-GET; never invent capture without provider evidence.';
