-- ============================================================
-- Private Realtime Broadcast auth for Scheduled Jobs marketplace.
-- Topic: scheduled-marketplace:{service_area_id}
--
-- Extends the existing authenticated scoped-channel SELECT model so
-- drivers can join ONLY service areas they are assigned to
-- (drivers.service_area_id OR driver_service_areas).
--
-- Clients must subscribe with config.private = true.
-- Edge service_role owns send (authenticated INSERT not granted here).
-- Does NOT disable project-wide public channels.
-- NOT APPLIED until explicit production approval.
-- ============================================================

DO $$
BEGIN
  IF to_regclass('realtime.messages') IS NULL THEN
    RAISE EXCEPTION 'realtime.messages missing — cannot authorise scheduled marketplace broadcast';
  END IF;
END $$;

ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Drivers receive scheduled marketplace broadcast" ON realtime.messages;
CREATE POLICY "Drivers receive scheduled marketplace broadcast"
  ON realtime.messages
  FOR SELECT
  TO authenticated
  USING (
    extension = 'broadcast'
    AND topic LIKE 'scheduled-marketplace:%'
    AND EXISTS (
      SELECT 1
      FROM public.drivers d
      WHERE d.id = public.current_driver_profile_id()
        AND (
          d.service_area_id::text = split_part(topic, ':', 2)
          OR EXISTS (
            SELECT 1
            FROM public.driver_service_areas dsa
            WHERE dsa.driver_id = d.id
              AND dsa.service_area_id::text = split_part(topic, ':', 2)
          )
        )
    )
  );

COMMENT ON POLICY "Drivers receive scheduled marketplace broadcast" ON realtime.messages IS
  'Private scheduled-marketplace:{sa} receive: driver must be assigned to that service area.';
