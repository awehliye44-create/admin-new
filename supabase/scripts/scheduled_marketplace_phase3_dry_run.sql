-- Phase 3 dry-run: authoritative hold classification (read-only).
-- DO NOT mass-publish. Requires migration 20270213120000 columns when applied.
-- Run: supabase db query --linked -f supabase/scripts/scheduled_marketplace_phase3_dry_run.sql

WITH candidates AS (
  SELECT
    t.id,
    t.trip_code,
    t.booking_source,
    t.scheduled_status,
    t.scheduled_hold_reason,
    t.scheduled_broadcast_at,
    t.broadcast_enabled,
    t.airport_charge_pence,
    t.pending_release_kind,
    t.driver_id,
    t.confirmed_driver_id,
    t.completed_at,
    t.cancelled_at,
    t.status,
    CASE
      WHEN t.completed_at IS NOT NULL OR t.cancelled_at IS NOT NULL
        OR lower(coalesce(t.status,'')) IN ('completed','cancelled','no_show','expired','expired_no_driver')
        OR lower(coalesce(t.scheduled_status,'')) IN ('cancelled','converted_to_instant','no_driver_found')
        THEN 'terminal'
      WHEN t.driver_id IS NOT NULL OR t.confirmed_driver_id IS NOT NULL
        THEN 'already_assigned'
      WHEN t.broadcast_enabled IS FALSE
        OR coalesce(t.scheduled_hold_reason,'') = 'airport_pricing'
        THEN 'airport_pricing'
      WHEN coalesce(t.scheduled_hold_reason,'') = 'payment_gate'
        OR lower(coalesce(t.scheduled_status,'')) = 'payment_gate_blocked'
        THEN 'payment_gate'
      WHEN coalesce(t.scheduled_hold_reason,'') = 'manual_trip'
        THEN 'manual_trip'
      WHEN coalesce(t.scheduled_hold_reason,'') = 'admin_exceptional'
        THEN 'admin_exceptional'
      WHEN coalesce(t.scheduled_hold_reason,'') = 'publication_retry'
        THEN 'publication_retry'
      WHEN coalesce(t.scheduled_hold_reason,'') = 'publication_pending'
        THEN 'publication_pending'
      WHEN lower(coalesce(t.scheduled_status,'')) <> 'admin_held'
        AND t.scheduled_broadcast_at IS NOT NULL
        AND t.scheduled_broadcast_at <= now()
        THEN 'already_published'
      WHEN coalesce(t.scheduled_hold_reason,'') = 'unknown_historical'
        OR (t.scheduled_hold_reason IS NULL AND lower(coalesce(t.scheduled_status,'')) = 'admin_held')
        THEN 'unknown_historical'
      ELSE 'review'
    END AS hold_class
  FROM public.trips t
  WHERE coalesce(t.dispatch_mode, '') = 'scheduled'
     OR coalesce(t.is_scheduled, false) = true
)
SELECT hold_class, count(*)::int AS cnt
FROM candidates
GROUP BY hold_class
ORDER BY cnt DESC;

-- Trip IDs for each actionable / review class (capped)
SELECT hold_class, id, trip_code, booking_source, scheduled_status, scheduled_hold_reason
FROM (
  SELECT c.*,
    row_number() OVER (PARTITION BY hold_class ORDER BY id) AS rn
  FROM candidates c
  WHERE hold_class IN (
    'publication_pending',
    'publication_retry',
    'manual_trip',
    'admin_exceptional',
    'payment_gate',
    'airport_pricing',
    'unknown_historical'
  )
) s
WHERE rn <= 25
ORDER BY hold_class, id;
