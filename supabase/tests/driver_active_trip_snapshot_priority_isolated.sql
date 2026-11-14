\set ON_ERROR_STOP on
\pset pager off

-- Isolated selection proof for MK-261114-002 snapshot priority.
-- Does not call the SECURITY DEFINER RPC (auth.uid scoped). Exercises the
-- immutable helpers + the same WHERE/ORDER BY the draft migration uses.
-- Run after applying draft helpers, or load helpers from the draft file first.

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

\echo === helper: future scheduled / marketplace / searching are NOT active
SELECT t_ok(NOT public.is_driver_active_trip_snapshot_status('scheduled'), 'scheduled excluded');
SELECT t_ok(NOT public.is_driver_active_trip_snapshot_status('scheduled_committed'), 'scheduled_committed excluded');
SELECT t_ok(NOT public.is_driver_active_trip_snapshot_status('searching'), 'searching excluded');
SELECT t_ok(NOT public.is_driver_active_trip_snapshot_status('broadcasting'), 'broadcasting excluded');
SELECT t_ok(NOT public.is_driver_active_trip_snapshot_status('queued'), 'queued excluded');
SELECT t_ok(NOT public.is_driver_active_trip_snapshot_status('completed'), 'completed excluded');
SELECT t_ok(NOT public.is_driver_active_trip_snapshot_status('cancelled'), 'cancelled excluded');

\echo === helper: genuine live workflow statuses ARE active
SELECT t_ok(public.is_driver_active_trip_snapshot_status('en_route_to_pickup'), 'en_route_to_pickup allowed');
SELECT t_ok(public.is_driver_active_trip_snapshot_status('at_pickup'), 'at_pickup allowed');
SELECT t_ok(public.is_driver_active_trip_snapshot_status('in_progress'), 'in_progress allowed');
SELECT t_ok(public.is_driver_active_trip_snapshot_status('driver_assigned'), 'driver_assigned allowed');
SELECT t_ok(public.is_driver_active_trip_snapshot_status('at_stop'), 'at_stop allowed');

\echo === lifecycle rank prefers in_progress over en_route over driver_assigned
SELECT t_ok(
  public.driver_active_trip_snapshot_lifecycle_rank('in_progress')
    < public.driver_active_trip_snapshot_lifecycle_rank('en_route_to_pickup'),
  'in_progress ahead of en_route'
);
SELECT t_ok(
  public.driver_active_trip_snapshot_lifecycle_rank('en_route_to_pickup')
    < public.driver_active_trip_snapshot_lifecycle_rank('driver_assigned'),
  'en_route ahead of driver_assigned'
);
SELECT t_ok(
  public.driver_active_trip_snapshot_lifecycle_rank('at_pickup')
    < public.driver_active_trip_snapshot_lifecycle_rank('en_route_to_pickup'),
  'at_pickup ahead of en_route'
);

\echo === cold-start selection: newer scheduled must not beat older active trip
CREATE TEMP TABLE snap_candidates (
  id text PRIMARY KEY,
  status text NOT NULL,
  updated_at timestamptz NOT NULL
) ON COMMIT DROP;

INSERT INTO snap_candidates (id, status, updated_at) VALUES
  ('active-en-route', 'en_route_to_pickup', now() - interval '1 hour'),
  ('future-scheduled', 'scheduled', now() - interval '1 minute'),
  ('queued-stack', 'queued', now());

WITH picked AS (
  SELECT id
  FROM snap_candidates t
  WHERE public.is_driver_active_trip_snapshot_status(t.status)
  ORDER BY
    public.driver_active_trip_snapshot_lifecycle_rank(t.status) ASC,
    t.updated_at DESC NULLS LAST
  LIMIT 1
)
SELECT t_ok((SELECT id FROM picked) = 'active-en-route', 'active beats newer scheduled');

\echo === only future scheduled → empty active selection
DELETE FROM snap_candidates;
INSERT INTO snap_candidates (id, status, updated_at) VALUES
  ('future-a', 'scheduled', now()),
  ('future-b', 'scheduled_committed', now() - interval '5 minutes');

WITH picked AS (
  SELECT id
  FROM snap_candidates t
  WHERE public.is_driver_active_trip_snapshot_status(t.status)
  ORDER BY
    public.driver_active_trip_snapshot_lifecycle_rank(t.status) ASC,
    t.updated_at DESC NULLS LAST
  LIMIT 1
)
SELECT t_ok(NOT EXISTS (SELECT 1 FROM picked), 'scheduled-only yields empty active');

\echo === in_progress preferred over newer driver_assigned sibling
DELETE FROM snap_candidates;
INSERT INTO snap_candidates (id, status, updated_at) VALUES
  ('live-progress', 'in_progress', now() - interval '30 minutes'),
  ('other-assigned', 'driver_assigned', now());

WITH picked AS (
  SELECT id
  FROM snap_candidates t
  WHERE public.is_driver_active_trip_snapshot_status(t.status)
  ORDER BY
    public.driver_active_trip_snapshot_lifecycle_rank(t.status) ASC,
    t.updated_at DESC NULLS LAST
  LIMIT 1
)
SELECT t_ok((SELECT id FROM picked) = 'live-progress', 'in_progress beats newer driver_assigned');

\echo === multi-stop at_stop preferred over en_route
DELETE FROM snap_candidates;
INSERT INTO snap_candidates (id, status, updated_at) VALUES
  ('stop-wait', 'at_stop', now() - interval '10 minutes'),
  ('heading', 'en_route_to_pickup', now());

WITH picked AS (
  SELECT id
  FROM snap_candidates t
  WHERE public.is_driver_active_trip_snapshot_status(t.status)
  ORDER BY
    public.driver_active_trip_snapshot_lifecycle_rank(t.status) ASC,
    t.updated_at DESC NULLS LAST
  LIMIT 1
)
SELECT t_ok((SELECT id FROM picked) = 'stop-wait', 'at_stop beats newer en_route');

DROP FUNCTION IF EXISTS public.t_ok(boolean, text);
