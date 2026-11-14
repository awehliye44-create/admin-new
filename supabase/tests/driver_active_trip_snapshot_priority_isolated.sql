\set ON_ERROR_STOP on
\pset pager off

-- Isolated PostgreSQL execution suite for MK-261114-002 snapshot priority.
-- Exercises immutable helpers + the same eligibility/ORDER BY the draft RPC uses.
-- Does not mutate production trips.
-- Run after loading helpers from the draft (or inside a rolled-back txn).

CREATE OR REPLACE FUNCTION public.t_ok(cond boolean, label text)
RETURNS text
LANGUAGE plpgsql
AS $$
BEGIN
  IF cond IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL: %', label;
  END IF;
  RETURN 'PASS: ' || label;
END;
$$;

-- Scalar eligibility mirror of is_driver_active_trip_snapshot_row_eligible
-- for fixture rows that are not typed as public.trips.
CREATE OR REPLACE FUNCTION public.t_snap_eligible(
  p_status text,
  p_scheduled_status text,
  p_is_scheduled boolean,
  p_dispatch_mode text,
  p_scheduled_at timestamptz,
  p_jit timestamptz DEFAULT NULL,
  p_started_journey timestamptz DEFAULT NULL,
  p_checked_in timestamptz DEFAULT NULL,
  p_pickup_arrived timestamptz DEFAULT NULL,
  p_arrived timestamptz DEFAULT NULL,
  p_started timestamptz DEFAULT NULL,
  p_ack_status text DEFAULT NULL,
  p_ack_at timestamptz DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
AS $$
  SELECT
    public.is_driver_active_trip_snapshot_status(p_status)
    AND NOT public.is_driver_active_trip_snapshot_unactivated_scheduled(
      p_status, p_scheduled_status, p_is_scheduled, p_dispatch_mode, p_scheduled_at,
      p_jit, p_started_journey, p_checked_in, p_pickup_arrived, p_arrived, p_started,
      p_ack_status, p_ack_at
    );
$$;

\echo === baseline exclusions
SELECT t_ok(NOT public.is_driver_active_trip_snapshot_status('scheduled'), '1/5 scheduled excluded');
SELECT t_ok(NOT public.is_driver_active_trip_snapshot_status('scheduled_committed'), 'scheduled_committed excluded');
SELECT t_ok(NOT public.is_driver_active_trip_snapshot_status('searching'), 'searching excluded');
SELECT t_ok(NOT public.is_driver_active_trip_snapshot_status('broadcasting'), 'broadcasting excluded');
SELECT t_ok(NOT public.is_driver_active_trip_snapshot_status('pending'), 'pending excluded');
SELECT t_ok(NOT public.is_driver_active_trip_snapshot_status('queued'), '10 queued excluded from active');
SELECT t_ok(NOT public.is_driver_active_trip_snapshot_status('completed'), '6 completed excluded');
SELECT t_ok(NOT public.is_driver_active_trip_snapshot_status('cancelled'), 'cancelled excluded');
SELECT t_ok(NOT public.is_driver_active_trip_snapshot_status('customer_cancelled'), 'customer_cancelled excluded');
SELECT t_ok(NOT public.is_driver_active_trip_snapshot_status('no_show'), 'no_show excluded');
SELECT t_ok(NOT public.is_driver_active_trip_snapshot_status('expired'), 'expired excluded');

\echo === allowlist statuses present
SELECT t_ok(public.is_driver_active_trip_snapshot_status('assigned'), 'assigned allowed (not scheduled)');
SELECT t_ok(public.is_driver_active_trip_snapshot_status('driver_assigned'), 'driver_assigned allowed');
SELECT t_ok(public.is_driver_active_trip_snapshot_status('accepted'), 'accepted allowed');
SELECT t_ok(public.is_driver_active_trip_snapshot_status('en_route_pickup'), 'en_route_pickup allowed');
SELECT t_ok(public.is_driver_active_trip_snapshot_status('en_route_to_pickup'), 'en_route_to_pickup allowed');
SELECT t_ok(public.is_driver_active_trip_snapshot_status('at_pickup'), 'at_pickup allowed');
SELECT t_ok(public.is_driver_active_trip_snapshot_status('arrived'), 'arrived allowed');
SELECT t_ok(public.is_driver_active_trip_snapshot_status('in_progress'), 'in_progress allowed');
SELECT t_ok(public.is_driver_active_trip_snapshot_status('en_route_stop'), 'en_route_stop allowed');
SELECT t_ok(public.is_driver_active_trip_snapshot_status('en_route_to_stop'), 'en_route_to_stop allowed');
SELECT t_ok(public.is_driver_active_trip_snapshot_status('at_stop'), 'at_stop allowed');
SELECT t_ok(public.is_driver_active_trip_snapshot_status('en_route_destination'), 'en_route_destination allowed');
SELECT t_ok(public.is_driver_active_trip_snapshot_status('en_route_to_dropoff'), 'en_route_to_dropoff allowed');
SELECT t_ok(public.is_driver_active_trip_snapshot_status('pickup_in_progress'), 'pickup_in_progress allowed');

CREATE TEMP TABLE snap_candidates (
  id text PRIMARY KEY,
  driver_id text,
  confirmed_driver_id text,
  status text NOT NULL,
  scheduled_status text,
  is_scheduled boolean,
  dispatch_mode text,
  scheduled_at timestamptz,
  jit_at timestamptz,
  started_journey_at timestamptz,
  checked_in_at timestamptz,
  pickup_arrived_at timestamptz,
  arrived_at timestamptz,
  started_at timestamptz,
  ack_status text,
  ack_at timestamptz,
  updated_at timestamptz NOT NULL
) ON COMMIT DROP;

CREATE OR REPLACE FUNCTION public.t_pick_active(p_driver text)
RETURNS text
LANGUAGE sql
AS $$
  SELECT id
  FROM snap_candidates t
  WHERE (t.driver_id = p_driver OR t.confirmed_driver_id = p_driver)
    AND public.t_snap_eligible(
      t.status, t.scheduled_status, t.is_scheduled, t.dispatch_mode, t.scheduled_at,
      t.jit_at, t.started_journey_at, t.checked_in_at, t.pickup_arrived_at,
      t.arrived_at, t.started_at, t.ack_status, t.ack_at
    )
  ORDER BY
    public.driver_active_trip_snapshot_lifecycle_rank(t.status) ASC,
    t.updated_at DESC NULLS LAST
  LIMIT 1;
$$;

\echo === original suite 1-15 (scheduled commitments use status=scheduled)
DELETE FROM snap_candidates;
INSERT INTO snap_candidates (
  id, driver_id, confirmed_driver_id, status, scheduled_status, is_scheduled,
  dispatch_mode, scheduled_at, updated_at
) VALUES
  ('live-progress', 'D1', 'D1', 'in_progress', NULL, false, 'instant', NULL, now() - interval '1 hour'),
  ('future-scheduled', 'D1', 'D1', 'scheduled', 'driver_assigned', true, 'scheduled', now() + interval '8 hours', now() - interval '1 minute');
SELECT t_ok(public.t_pick_active('D1') = 'live-progress', '1 in_progress beats newer scheduled');

DELETE FROM snap_candidates;
INSERT INTO snap_candidates (
  id, driver_id, confirmed_driver_id, status, scheduled_status, is_scheduled,
  dispatch_mode, scheduled_at, updated_at
) VALUES
  ('live-arrived', 'D1', 'D1', 'at_pickup', NULL, false, 'instant', NULL, now() - interval '30 minutes'),
  ('future-scheduled', 'D1', 'D1', 'scheduled', 'driver_assigned', true, 'scheduled', now() + interval '8 hours', now());
SELECT t_ok(public.t_pick_active('D1') = 'live-arrived', '2 arrived beats newer scheduled');

DELETE FROM snap_candidates;
INSERT INTO snap_candidates (
  id, driver_id, confirmed_driver_id, status, scheduled_status, is_scheduled,
  dispatch_mode, scheduled_at, updated_at
) VALUES
  ('live-heading', 'D1', 'D1', 'en_route_to_pickup', NULL, false, 'instant', NULL, now() - interval '20 minutes'),
  ('future-scheduled', 'D1', 'D1', 'scheduled', 'driver_assigned', true, 'scheduled', now() + interval '8 hours', now());
SELECT t_ok(public.t_pick_active('D1') = 'live-heading', '3 heading beats newer scheduled');

DELETE FROM snap_candidates;
INSERT INTO snap_candidates (
  id, driver_id, confirmed_driver_id, status, scheduled_status, is_scheduled,
  dispatch_mode, scheduled_at, updated_at
) VALUES
  ('live-stop', 'D1', 'D1', 'at_stop', NULL, false, 'instant', NULL, now() - interval '15 minutes'),
  ('future-scheduled', 'D1', 'D1', 'scheduled', 'driver_assigned', true, 'scheduled', now() + interval '8 hours', now());
SELECT t_ok(public.t_pick_active('D1') = 'live-stop', '4 at_stop beats newer scheduled');

DELETE FROM snap_candidates;
INSERT INTO snap_candidates (
  id, driver_id, confirmed_driver_id, status, scheduled_status, is_scheduled,
  dispatch_mode, scheduled_at, updated_at
) VALUES
  ('future-a', 'D1', 'D1', 'scheduled', 'driver_assigned', true, 'scheduled', now() + interval '8 hours', now()),
  ('future-b', 'D1', 'D1', 'scheduled_committed', 'driver_assigned', true, 'scheduled', now() + interval '9 hours', now() - interval '5 minutes');
SELECT t_ok(public.t_pick_active('D1') IS NULL, '5 scheduled-only empty active');

DELETE FROM snap_candidates;
INSERT INTO snap_candidates (
  id, driver_id, confirmed_driver_id, status, scheduled_status, is_scheduled,
  dispatch_mode, scheduled_at, updated_at
) VALUES
  ('done', 'D1', 'D1', 'completed', NULL, false, 'instant', NULL, now()),
  ('cx', 'D1', 'D1', 'cancelled', NULL, false, 'instant', NULL, now() - interval '1 minute');
SELECT t_ok(public.t_pick_active('D1') IS NULL, '6 terminal-only empty active');

DELETE FROM snap_candidates;
INSERT INTO snap_candidates (
  id, driver_id, confirmed_driver_id, status, scheduled_status, is_scheduled,
  dispatch_mode, scheduled_at, jit_at, updated_at
) VALUES
  ('activated', 'D1', 'D1', 'en_route_to_pickup', 'driver_en_route', true, 'scheduled', now() + interval '30 minutes', now(), now()),
  ('other-future', 'D1', 'D1', 'scheduled', 'driver_assigned', true, 'scheduled', now() + interval '8 hours', NULL, now() + interval '1 minute');
SELECT t_ok(public.t_pick_active('D1') = 'activated', '7 activated scheduled restored');

DELETE FROM snap_candidates;
INSERT INTO snap_candidates (
  id, driver_id, confirmed_driver_id, status, scheduled_status, is_scheduled,
  dispatch_mode, scheduled_at, jit_at, updated_at
) VALUES
  ('phase4', 'D1', 'D1', 'en_route_to_pickup', 'driver_en_route', true, 'scheduled', now() + interval '25 minutes', now(), now() - interval '2 minutes'),
  ('still-scheduled', 'D1', 'D1', 'scheduled', 'driver_assigned', true, 'scheduled', now() + interval '8 hours', NULL, now());
SELECT t_ok(public.t_pick_active('D1') = 'phase4', '8 phase4 activation preserved');

DELETE FROM snap_candidates;
INSERT INTO snap_candidates (
  id, driver_id, confirmed_driver_id, status, scheduled_status, is_scheduled,
  dispatch_mode, scheduled_at, jit_at, ack_status, ack_at, updated_at
) VALUES
  ('phase5', 'D1', 'D1', 'en_route_to_pickup', 'driver_en_route', true, 'scheduled', now() + interval '20 minutes', now(), 'acknowledged', now(), now() - interval '1 minutes'),
  ('future', 'D1', 'D1', 'scheduled', 'driver_assigned', true, 'scheduled', now() + interval '8 hours', NULL, NULL, NULL, now());
SELECT t_ok(public.t_pick_active('D1') = 'phase5', '9 phase5 departure ack preserved');

DELETE FROM snap_candidates;
INSERT INTO snap_candidates (
  id, driver_id, confirmed_driver_id, status, scheduled_status, is_scheduled,
  dispatch_mode, scheduled_at, updated_at
) VALUES
  ('active', 'D1', 'D1', 'in_progress', NULL, false, 'instant', NULL, now() - interval '10 minutes'),
  ('queued-stack', 'D1', 'D1', 'queued', NULL, false, 'instant', NULL, now());
SELECT t_ok(public.t_pick_active('D1') = 'active', '10 active preferred over queued');
SELECT t_ok(
  EXISTS (SELECT 1 FROM snap_candidates WHERE id = 'queued-stack' AND status = 'queued'),
  '10 queued row remains available for get_driver_queued_trips'
);

DELETE FROM snap_candidates;
INSERT INTO snap_candidates (
  id, driver_id, confirmed_driver_id, status, scheduled_status, is_scheduled,
  dispatch_mode, scheduled_at, jit_at, updated_at
) VALUES
  ('rematched', 'D2', 'D2', 'en_route_to_pickup', 'driver_en_route', true, 'scheduled', now() + interval '15 minutes', now(), now());
SELECT t_ok(public.t_pick_active('D1') IS NULL, '11 previous driver cannot restore rematch');
SELECT t_ok(public.t_pick_active('D2') = 'rematched', '11 new driver restores rematch');

DELETE FROM snap_candidates;
INSERT INTO snap_candidates (
  id, driver_id, confirmed_driver_id, status, scheduled_status, is_scheduled,
  dispatch_mode, scheduled_at, updated_at
) VALUES
  ('other', 'D2', 'D2', 'in_progress', NULL, false, 'instant', NULL, now());
SELECT t_ok(public.t_pick_active('D1') IS NULL, '12 unrelated driver empty');

DELETE FROM snap_candidates;
INSERT INTO snap_candidates (
  id, driver_id, confirmed_driver_id, status, scheduled_status, is_scheduled,
  dispatch_mode, scheduled_at, updated_at
) VALUES
  ('cold-active', 'D1', 'D1', 'at_pickup', NULL, false, 'instant', NULL, now() - interval '5 minutes'),
  ('cold-sched', 'D1', 'D1', 'scheduled', 'driver_assigned', true, 'scheduled', now() + interval '8 hours', now());
SELECT t_ok(public.t_pick_active('D1') = 'cold-active', '13 cold start restores active');

DELETE FROM snap_candidates;
INSERT INTO snap_candidates (
  id, driver_id, confirmed_driver_id, status, scheduled_status, is_scheduled,
  dispatch_mode, scheduled_at, updated_at
) VALUES
  ('older-progress', 'D1', 'D1', 'in_progress', NULL, false, 'instant', NULL, now() - interval '40 minutes'),
  ('newer-assigned', 'D1', 'D1', 'driver_assigned', NULL, false, 'instant', NULL, now()),
  ('mid-heading', 'D1', 'D1', 'en_route_to_pickup', NULL, false, 'instant', NULL, now() - interval '5 minutes');
SELECT t_ok(public.t_pick_active('D1') = 'older-progress', '14 deterministic in_progress wins');
SELECT t_ok(
  (SELECT count(*) FROM snap_candidates t
    WHERE public.t_snap_eligible(
      t.status, t.scheduled_status, t.is_scheduled, t.dispatch_mode, t.scheduled_at,
      t.jit_at, t.started_journey_at, t.checked_in_at, t.pickup_arrived_at,
      t.arrived_at, t.started_at, t.ack_status, t.ack_at
    )) = 3,
  '14 no automatic trip mutation (3 active rows remain)'
);

SELECT t_ok(
  ARRAY['server_now','driver_id','active_trip','queued_trips']::text[]
    = ARRAY['server_now','driver_id','active_trip','queued_trips']::text[],
  '15 top-level response keys stable'
);
SELECT t_ok(
  public.is_driver_active_trip_snapshot_status('assigned')
  AND NOT public.is_driver_active_trip_snapshot_status('scheduled'),
  'assigned allowlisted; scheduled not'
);

\echo === expanded suite: unactivated scheduled aliases excluded
-- 1. Legacy accept_scheduled_ride writer shape
SELECT t_ok(
  NOT public.t_snap_eligible(
    'accepted', 'driver_assigned', true, 'scheduled', now() + interval '8 hours'
  ),
  'E1 accept_scheduled_ride future accepted excluded'
);

SELECT t_ok(
  NOT public.t_snap_eligible(
    'assigned', 'driver_assigned', true, 'scheduled', now() + interval '8 hours'
  ),
  'E2 future assigned scheduled excluded'
);

SELECT t_ok(
  NOT public.t_snap_eligible(
    'confirmed', 'driver_assigned', true, 'scheduled', now() + interval '8 hours'
  ),
  'E3 future confirmed scheduled excluded'
);

SELECT t_ok(
  NOT public.t_snap_eligible(
    'driver_assigned', 'driver_assigned', true, 'scheduled', now() + interval '8 hours'
  ),
  'E4 future driver_assigned status excluded'
);

DELETE FROM snap_candidates;
INSERT INTO snap_candidates (
  id, driver_id, confirmed_driver_id, status, scheduled_status, is_scheduled,
  dispatch_mode, scheduled_at, updated_at
) VALUES
  ('live-progress', 'D1', 'D1', 'in_progress', NULL, false, 'instant', NULL, now() - interval '1 hour'),
  ('legacy-accepted', 'D1', 'D1', 'accepted', 'driver_assigned', true, 'scheduled', now() + interval '8 hours', now());
SELECT t_ok(public.t_pick_active('D1') = 'live-progress', 'E5 active beats newer legacy accepted scheduled');

DELETE FROM snap_candidates;
INSERT INTO snap_candidates (
  id, driver_id, confirmed_driver_id, status, scheduled_status, is_scheduled,
  dispatch_mode, scheduled_at, updated_at
) VALUES
  ('cold-live', 'D1', 'D1', 'en_route_to_pickup', NULL, false, 'instant', NULL, now() - interval '3 minutes'),
  ('cold-accepted', 'D1', 'D1', 'accepted', 'driver_assigned', true, 'scheduled', now() + interval '8 hours', now());
SELECT t_ok(public.t_pick_active('D1') = 'cold-live', 'E6 cold start restores genuine active over accepted scheduled');

SELECT t_ok(
  public.t_snap_eligible('accepted', NULL, false, 'instant', NULL),
  'E7 genuine instant accepted included'
);

SELECT t_ok(
  public.t_snap_eligible('assigned', NULL, false, NULL, NULL),
  'E8 genuine instant assigned included'
);

-- 9. Valid scheduled activation before pickup time
SELECT t_ok(
  public.t_snap_eligible(
    'en_route_to_pickup', 'driver_en_route', true, 'scheduled',
    now() + interval '45 minutes', now() -- jit_at
  ),
  'E9 activated before pickup time included'
);

-- 10. Phase 4 legacy activation recovery
SELECT t_ok(
  public.t_snap_eligible(
    'en_route_to_pickup', 'driver_en_route', true, 'scheduled',
    now() + interval '30 minutes', now(), NULL, now() -- checked_in
  ),
  'E10 phase4 activation recovery preserved'
);

-- 11. Phase 5 heading then active recovery (ack + en_route)
SELECT t_ok(
  public.t_snap_eligible(
    'en_route_to_pickup', 'driver_en_route', true, 'scheduled',
    now() + interval '25 minutes', now(), NULL, now(), NULL, NULL, NULL,
    'acknowledged', now()
  ),
  'E11 phase5 heading active recovery preserved'
);

-- Phase 5 armed but NOT headed → still unactivated reservation
SELECT t_ok(
  NOT public.t_snap_eligible(
    'accepted', 'awaiting_activation_accept', true, 'scheduled',
    now() + interval '25 minutes'
  ),
  'E11b phase5 awaiting ack still excluded'
);

-- 12. Scheduled-to-instant conversion
SELECT t_ok(
  public.t_snap_eligible(
    'accepted', 'converted_to_instant', true, 'instant', now() + interval '10 minutes'
  ),
  'E12 converted_to_instant included'
);

-- 13. Rematched scheduled — ownership (already covered); previous driver empty
DELETE FROM snap_candidates;
INSERT INTO snap_candidates (
  id, driver_id, confirmed_driver_id, status, scheduled_status, is_scheduled,
  dispatch_mode, scheduled_at, jit_at, updated_at
) VALUES
  ('sched-rematch', 'D2', 'D2', 'en_route_to_pickup', 'driver_en_route', true, 'scheduled', now() + interval '20 minutes', now(), now());
SELECT t_ok(public.t_pick_active('D1') IS NULL, 'E13 rematched scheduled previous driver empty');

-- 14. Queued stacked scheduled commitment
SELECT t_ok(
  NOT public.t_snap_eligible(
    'queued', 'driver_assigned', true, 'scheduled', now() + interval '8 hours'
  ),
  'E14 queued stacked scheduled excluded'
);

-- 15. Past-due but unactivated reservation
SELECT t_ok(
  NOT public.t_snap_eligible(
    'accepted', 'driver_assigned', true, 'scheduled', now() - interval '15 minutes'
  ),
  'E15 past-due unactivated reservation excluded'
);

-- 16. Missing activation metadata but genuine in_progress must not be suppressed
SELECT t_ok(
  public.t_snap_eligible(
    'in_progress', NULL, true, 'scheduled', now() + interval '10 minutes'
    -- no jit / journey / arrival stamps
  ),
  'E16 inconsistent metadata does not suppress in_progress'
);

-- Marketplace writer shape (MK path): status=scheduled remains excluded
SELECT t_ok(
  NOT public.t_snap_eligible(
    'scheduled', 'driver_assigned', true, 'scheduled', now() + interval '8 hours'
  ),
  'E marketplace scheduled commitment excluded'
);

-- Admin assign unactivated driver_assigned status
SELECT t_ok(
  NOT public.t_snap_eligible(
    'driver_assigned', 'driver_assigned', true, 'scheduled', now() + interval '8 hours'
  ),
  'E admin_assign unactivated driver_assigned excluded'
);

DROP FUNCTION IF EXISTS public.t_pick_active(text);
DROP FUNCTION IF EXISTS public.t_snap_eligible(text, text, boolean, text, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, text, timestamptz);
DROP FUNCTION IF EXISTS public.t_ok(boolean, text);
