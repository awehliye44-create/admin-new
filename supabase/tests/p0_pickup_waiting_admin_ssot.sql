-- P0 #2 SQL contract checks (run against live after migration apply).
-- Does not mutate production trips beyond ephemeral test rows if created.

-- 1) Columns exist
SELECT
  (SELECT COUNT(*) FROM information_schema.columns
   WHERE table_name='trips' AND column_name IN (
     'pickup_waiting_finalized_at',
     'pickup_waiting_intervals_charged',
     'pickup_waiting_chargeable_seconds',
     'pickup_waiting_last_tick_at'
   )) = 4 AS waiting_billing_columns_ok;

-- 2) MK Admin SSOT truth (vehicle a5c59e9b = 25p, free 3, paid true; SA interval 15)
WITH mk AS (
  SELECT id FROM service_areas WHERE name ILIKE '%milton%' LIMIT 1
),
fare AS (
  SELECT fps.*
  FROM fare_pricing_settings fps, mk
  WHERE fps.service_area_id = mk.id
    AND fps.vehicle_type_id = 'a5c59e9b-ed66-4dd1-8043-1f4730691c12'
  ORDER BY fps.updated_at DESC NULLS LAST
  LIMIT 1
),
disp AS (
  SELECT ds.*
  FROM dispatch_settings ds, mk
  WHERE ds.service_area_id = mk.id
  LIMIT 1
)
SELECT
  (SELECT free_waiting_minutes FROM fare) = 3 AS mk_free_3,
  (SELECT pickup_paid_waiting_enabled FROM fare) IS TRUE AS mk_paid_true,
  (SELECT waiting_per_minute_pence FROM fare) = 25 AS mk_rate_25,
  (SELECT stop_waiting_charge_interval_seconds FROM disp) = 15 AS mk_interval_15;

-- 3) Trigger prefers fare rate over dispatch (function source check)
SELECT pg_get_functiondef('public.persist_pickup_waiting_admin_ssot'::regproc)
  LIKE '%COALESCE(v_fare_rate, v_dispatch_rate%' AS trigger_fare_rate_wins;

-- 4) Snapshot exposes finalize fields
SELECT pg_get_functiondef('public.get_driver_active_trip_snapshot'::regproc)
  LIKE '%pickup_waiting_finalized_at%' AS snapshot_has_finalized;

-- 5) Trigger never resets started_at (idempotent Arrived guard present)
SELECT pg_get_functiondef('public.persist_pickup_waiting_admin_ssot'::regproc)
  LIKE '%OLD.pickup_waiting_started_at IS NOT NULL%' AS trigger_blocks_started_at_reset;

-- 6) Trigger includes completed_intervals rounding marker
SELECT pg_get_functiondef('public.persist_pickup_waiting_admin_ssot'::regproc)
  LIKE '%completed_intervals%' AS trigger_documents_rounding;

-- 7) Trigger never invents max minutes = 15
SELECT pg_get_functiondef('public.persist_pickup_waiting_admin_ssot'::regproc)
  NOT LIKE '%COALESCE(v_max_minutes, 15)%' AS trigger_no_invent_max_15;

-- 8) Trigger persists waiting_context + frozen_at provenance
SELECT
  pg_get_functiondef('public.persist_pickup_waiting_admin_ssot'::regproc) LIKE '%waiting_context%' AS trigger_waiting_context,
  pg_get_functiondef('public.persist_pickup_waiting_admin_ssot'::regproc) LIKE '%frozen_at%' AS trigger_frozen_at;
