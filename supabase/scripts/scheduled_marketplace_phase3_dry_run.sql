-- Phase 3 dry-run: classify existing scheduled holds before any bulk publish.
-- DO NOT mass-publish. DO NOT apply production mutations from this script.
-- Run: supabase db query --linked -f supabase/scripts/scheduled_marketplace_phase3_dry_run.sql

-- Taxonomy (first match wins) — mirrors scheduledMarketplaceAutoPublishSSOT.classifyScheduledMarketplaceHold

WITH candidates AS (
  SELECT
    t.id,
    t.trip_code,
    t.booking_source,
    t.dispatch_mode,
    t.status,
    t.scheduled_status,
    t.scheduled_at,
    t.scheduled_broadcast_at,
    t.driver_id,
    t.confirmed_driver_id,
    t.broadcast_enabled,
    t.airport_charge_pence,
    t.pending_release_kind,
    t.pending_release_at,
    t.completed_at,
    t.cancelled_at,
    t.created_at,
    CASE
      WHEN t.completed_at IS NOT NULL
        OR t.cancelled_at IS NOT NULL
        OR lower(coalesce(t.status, '')) IN (
          'completed', 'cancelled', 'customer_cancelled', 'driver_cancelled',
          'no_show', 'expired', 'expired_no_driver'
        )
        OR lower(coalesce(t.scheduled_status, '')) IN (
          'cancelled', 'expired', 'no_driver_found', 'converted_to_instant'
        )
        OR t.driver_id IS NOT NULL
        THEN 'terminal_or_live'
      WHEN lower(coalesce(t.scheduled_status, '')) = 'payment_gate_blocked'
        THEN 'payment_gate_blocked'
      WHEN t.broadcast_enabled IS FALSE AND coalesce(t.airport_charge_pence, 0) > 0
        THEN 'airport_pricing_hold'
      WHEN t.broadcast_enabled IS FALSE
        THEN 'other_broadcast_disabled'
      WHEN t.pending_release_kind IS NOT NULL AND t.pending_release_at IS NOT NULL
        THEN 'exceptional_pending_release'
      WHEN t.confirmed_driver_id IS NOT NULL AND t.driver_id IS NULL
        THEN 'preconfirmed'
      WHEN lower(coalesce(t.booking_source, '')) IN ('admin_manual', 'manual_trip', 'admin')
        AND lower(coalesce(t.scheduled_status, '')) = 'admin_held'
        THEN 'manual_admin_hold'
      WHEN lower(coalesce(t.scheduled_status, '')) IN ('scheduled', 'pending', 'broadcasting')
        AND t.scheduled_broadcast_at IS NOT NULL
        AND t.scheduled_broadcast_at <= now()
        AND t.driver_id IS NULL
        AND t.confirmed_driver_id IS NULL
        THEN 'already_published'
      WHEN lower(coalesce(t.scheduled_status, '')) = 'admin_held'
        AND t.scheduled_broadcast_at IS NULL
        AND t.driver_id IS NULL
        AND t.confirmed_driver_id IS NULL
        THEN 'routine_admin_held'
      WHEN lower(coalesce(t.scheduled_status, '')) IN ('scheduled', 'pending', '')
        AND t.scheduled_broadcast_at IS NULL
        AND t.driver_id IS NULL
        AND t.confirmed_driver_id IS NULL
        THEN 'legacy_unpublished'
      ELSE 'review'
    END AS hold_class
  FROM public.trips t
  WHERE coalesce(t.dispatch_mode, '') = 'scheduled'
     OR coalesce(t.is_scheduled, false) = true
)
SELECT
  hold_class,
  count(*)::int AS cnt,
  CASE hold_class
    WHEN 'routine_admin_held' THEN 'candidate_auto_publish_after_review'
    WHEN 'legacy_unpublished' THEN 'candidate_auto_publish_after_review'
    WHEN 'already_published' THEN 'no_action'
    WHEN 'manual_admin_hold' THEN 'admin_review'
    WHEN 'airport_pricing_hold' THEN 'do_not_publish'
    WHEN 'payment_gate_blocked' THEN 'do_not_publish'
    WHEN 'exceptional_pending_release' THEN 'preserve_admin_intent'
    WHEN 'preconfirmed' THEN 'no_action'
    WHEN 'terminal_or_live' THEN 'no_action'
    ELSE 'admin_review'
  END AS proposed_action
FROM candidates
GROUP BY hold_class, proposed_action
ORDER BY cnt DESC;

-- Sample routine held rows (review before any bulk publish)
SELECT
  id,
  trip_code,
  booking_source,
  scheduled_status,
  scheduled_at,
  created_at,
  broadcast_enabled,
  airport_charge_pence
FROM public.trips
WHERE dispatch_mode = 'scheduled'
  AND scheduled_status = 'admin_held'
  AND scheduled_broadcast_at IS NULL
  AND driver_id IS NULL
  AND confirmed_driver_id IS NULL
  AND coalesce(broadcast_enabled, true) = true
  AND lower(coalesce(booking_source, '')) NOT IN ('admin_manual', 'manual_trip', 'admin')
ORDER BY created_at DESC
LIMIT 50;
