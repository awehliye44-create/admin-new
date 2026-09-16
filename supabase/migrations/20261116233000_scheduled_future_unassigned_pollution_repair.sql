-- MK-260916-038 Phase 8: repair ONLY future unassigned polluted scheduled rows.
-- Live classification at authoring time:
--   1 row: ccac3df7-22f8-4564-8546-115b29cfd413 (MK-260916-038)
--     status=scheduled, scheduled_status=broadcasting, anchors NULL,
--     driver_id NULL, confirmed_driver_id NULL, started_at NULL.
-- Assigned / active / completed / cancelled rows are NOT updated.

UPDATE public.trips AS t
SET
  scheduled_status = 'scheduled',
  scheduled_broadcast_at = a.scheduled_broadcast_at,
  scheduled_convert_at = a.scheduled_convert_at,
  updated_at = now()
FROM public.compute_scheduled_dispatch_anchors(t.scheduled_at, t.created_at) AS a
WHERE t.is_scheduled IS TRUE
  AND t.scheduled_at > now()
  AND t.scheduled_status = 'broadcasting'
  AND t.scheduled_broadcast_at IS NULL
  AND t.driver_id IS NULL
  AND t.confirmed_driver_id IS NULL
  AND t.started_at IS NULL
  AND t.completed_at IS NULL
  AND t.cancelled_at IS NULL
  AND lower(COALESCE(t.status, '')) = 'scheduled';
