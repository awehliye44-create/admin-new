-- #67A: Authoritative nested negotiation payload for Customer Realtime (postgres_changes).
-- Edges stamp this after durable negotiation commits; Customer applies without full restore.
ALTER TABLE public.trips
  ADD COLUMN IF NOT EXISTS customer_negotiation_view jsonb;

COMMENT ON COLUMN public.trips.customer_negotiation_view IS
  'Authoritative Customer in-card negotiation snapshot (offer_id, phase, presets, absolute deadlines). Stamped by fare Edges; null when not negotiating.';
