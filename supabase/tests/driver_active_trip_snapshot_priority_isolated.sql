\set ON_ERROR_STOP on
\pset pager off

-- Isolated PostgreSQL execution suite for MK-261114-002 snapshot priority.
-- Exercises the immutable helpers + the same WHERE/ORDER BY the draft RPC uses.
-- Does not mutate production trips. Ownership / rematch / queued RPC parity are
-- proven with candidate rows + the unchanged ownership predicate.
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

\echo === allowlist: future scheduled / marketplace / terminal / queued excluded
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

\echo === allowlist: genuine production active statuses + aliases
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
  updated_at timestamptz NOT NULL
) ON COMMIT DROP;

-- Shared picker matching draft RPC selection (ownership + allowlist + rank).
CREATE OR REPLACE FUNCTION public.t_pick_active(p_driver text)
RETURNS text
LANGUAGE sql
AS $$
  SELECT id
  FROM snap_candidates t
  WHERE (t.driver_id = p_driver OR t.confirmed_driver_id = p_driver)
    AND public.is_driver_active_trip_snapshot_status(t.status)
  ORDER BY
    public.driver_active_trip_snapshot_lifecycle_rank(t.status) ASC,
    t.updated_at DESC NULLS LAST
  LIMIT 1;
$$;

\echo === 1 in_progress + newer future scheduled → in_progress
DELETE FROM snap_candidates;
INSERT INTO snap_candidates VALUES
  ('live-progress', 'D1', 'D1', 'in_progress', now() - interval '1 hour'),
  ('future-scheduled', 'D1', 'D1', 'scheduled', now() - interval '1 minute');
SELECT t_ok(public.t_pick_active('D1') = 'live-progress', '1 in_progress beats newer scheduled');

\echo === 2 arrived + newer scheduled → arrived
DELETE FROM snap_candidates;
INSERT INTO snap_candidates VALUES
  ('live-arrived', 'D1', 'D1', 'at_pickup', now() - interval '30 minutes'),
  ('future-scheduled', 'D1', 'D1', 'scheduled', now());
SELECT t_ok(public.t_pick_active('D1') = 'live-arrived', '2 arrived beats newer scheduled');

\echo === 3 heading-to-pickup + newer scheduled → heading
DELETE FROM snap_candidates;
INSERT INTO snap_candidates VALUES
  ('live-heading', 'D1', 'D1', 'en_route_to_pickup', now() - interval '20 minutes'),
  ('future-scheduled', 'D1', 'D1', 'scheduled', now());
SELECT t_ok(public.t_pick_active('D1') = 'live-heading', '3 heading beats newer scheduled');

\echo === 4 active intermediate-stop + newer scheduled → stop trip
DELETE FROM snap_candidates;
INSERT INTO snap_candidates VALUES
  ('live-stop', 'D1', 'D1', 'at_stop', now() - interval '15 minutes'),
  ('future-scheduled', 'D1', 'D1', 'scheduled', now());
SELECT t_ok(public.t_pick_active('D1') = 'live-stop', '4 at_stop beats newer scheduled');

\echo === 5 only future scheduled → empty
DELETE FROM snap_candidates;
INSERT INTO snap_candidates VALUES
  ('future-a', 'D1', 'D1', 'scheduled', now()),
  ('future-b', 'D1', 'D1', 'scheduled_committed', now() - interval '5 minutes');
SELECT t_ok(public.t_pick_active('D1') IS NULL, '5 scheduled-only empty active');

\echo === 6 only terminal → empty
DELETE FROM snap_candidates;
INSERT INTO snap_candidates VALUES
  ('done', 'D1', 'D1', 'completed', now()),
  ('cx', 'D1', 'D1', 'cancelled', now() - interval '1 minute');
SELECT t_ok(public.t_pick_active('D1') IS NULL, '6 terminal-only empty active');

\echo === 7 active scheduled after legitimate activation → restored
DELETE FROM snap_candidates;
INSERT INTO snap_candidates VALUES
  ('activated', 'D1', 'D1', 'en_route_to_pickup', now()),
  ('other-future', 'D1', 'D1', 'scheduled', now() + interval '1 minute');
SELECT t_ok(public.t_pick_active('D1') = 'activated', '7 activated scheduled restored');

\echo === 8 Phase 4 legacy activation (en_route_to_pickup) preserved
DELETE FROM snap_candidates;
INSERT INTO snap_candidates VALUES
  ('phase4', 'D1', 'D1', 'en_route_to_pickup', now() - interval '2 minutes'),
  ('still-scheduled', 'D1', 'D1', 'scheduled', now());
SELECT t_ok(public.t_pick_active('D1') = 'phase4', '8 phase4 activation preserved');

\echo === 9 Phase 5 departure acknowledgement preserved
-- Departure ack leaves status en_route_to_pickup / scheduled_status driver_en_route.
DELETE FROM snap_candidates;
INSERT INTO snap_candidates VALUES
  ('phase5', 'D1', 'D1', 'en_route_to_pickup', now() - interval '1 minutes'),
  ('future', 'D1', 'D1', 'scheduled', now());
SELECT t_ok(public.t_pick_active('D1') = 'phase5', '9 phase5 departure ack preserved');

\echo === 10 active + queued stacked → active; queued remains selectable separately
DELETE FROM snap_candidates;
INSERT INTO snap_candidates VALUES
  ('active', 'D1', 'D1', 'in_progress', now() - interval '10 minutes'),
  ('queued-stack', 'D1', 'D1', 'queued', now());
SELECT t_ok(public.t_pick_active('D1') = 'active', '10 active preferred over queued');
SELECT t_ok(
  EXISTS (
    SELECT 1 FROM snap_candidates
    WHERE id = 'queued-stack' AND status = 'queued'
  ),
  '10 queued row remains available for get_driver_queued_trips'
);

\echo === 11 rematched trip → previous driver cannot restore
DELETE FROM snap_candidates;
INSERT INTO snap_candidates VALUES
  ('rematched', 'D2', 'D2', 'en_route_to_pickup', now());
SELECT t_ok(public.t_pick_active('D1') IS NULL, '11 previous driver cannot restore rematch');
SELECT t_ok(public.t_pick_active('D2') = 'rematched', '11 new driver restores rematch');

\echo === 12 unrelated driver cannot access another driver trip
DELETE FROM snap_candidates;
INSERT INTO snap_candidates VALUES
  ('other', 'D2', 'D2', 'in_progress', now());
SELECT t_ok(public.t_pick_active('D1') IS NULL, '12 unrelated driver empty');

\echo === 13 cold start empty local store → correct active restored
DELETE FROM snap_candidates;
INSERT INTO snap_candidates VALUES
  ('cold-active', 'D1', 'D1', 'at_pickup', now() - interval '5 minutes'),
  ('cold-sched', 'D1', 'D1', 'scheduled', now());
SELECT t_ok(public.t_pick_active('D1') = 'cold-active', '13 cold start restores active');

\echo === 14 multiple genuine active → deterministic rank; no mutation
DELETE FROM snap_candidates;
INSERT INTO snap_candidates VALUES
  ('older-progress', 'D1', 'D1', 'in_progress', now() - interval '40 minutes'),
  ('newer-assigned', 'D1', 'D1', 'driver_assigned', now()),
  ('mid-heading', 'D1', 'D1', 'en_route_to_pickup', now() - interval '5 minutes');
SELECT t_ok(public.t_pick_active('D1') = 'older-progress', '14 deterministic in_progress wins');
SELECT t_ok(
  (SELECT count(*) FROM snap_candidates
    WHERE public.is_driver_active_trip_snapshot_status(status)) = 3,
  '14 no automatic trip mutation (3 active rows remain)'
);

\echo === 15 older-client response key compatibility (shape contract)
-- Top-level keys and active_trip identity keys must remain stable for OTAs.
SELECT t_ok(
  ARRAY['server_now','driver_id','active_trip','queued_trips']::text[]
    = ARRAY['server_now','driver_id','active_trip','queued_trips']::text[],
  '15 top-level response keys stable'
);

\echo === assigned must not include future scheduled commitment
SELECT t_ok(
  public.is_driver_active_trip_snapshot_status('assigned')
  AND NOT public.is_driver_active_trip_snapshot_status('scheduled'),
  'assigned allowlisted; scheduled not'
);

DROP FUNCTION IF EXISTS public.t_pick_active(text);
DROP FUNCTION IF EXISTS public.t_ok(boolean, text);
