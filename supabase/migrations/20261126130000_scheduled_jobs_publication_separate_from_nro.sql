-- Separate Scheduled Jobs publication from NRO Broadcast.
--
-- Root cause: scheduled_marketplace_is_open only allowed scheduled_status in
-- ('broadcasting','awaiting_confirmation'), so Driver Scheduled Jobs Requested
-- only opened after STEP 2 NRO. Admin also never had a distinct
-- "Make Available in Scheduled Jobs" action (Broadcast was overloaded).
--
-- Fix: marketplace open for published scheduled jobs (status scheduled/pending/
-- broadcasting/awaiting_confirmation) when broadcast_at is due and not HELD /
-- not already preconfirmed. Broadcast NRO remains a separate Admin path.

CREATE OR REPLACE FUNCTION public.scheduled_marketplace_is_open(
  p_dispatch_mode text,
  p_scheduled_status text,
  p_status text,
  p_scheduled_at timestamp with time zone,
  p_scheduled_broadcast_at timestamp with time zone,
  p_created_at timestamp with time zone,
  p_driver_id uuid DEFAULT NULL::uuid,
  p_confirmed_driver_id uuid DEFAULT NULL::uuid,
  p_now timestamp with time zone DEFAULT now()
)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_broadcast timestamptz;
  v_status text := lower(COALESCE(p_status, ''));
  v_sched text := lower(COALESCE(p_scheduled_status, ''));
BEGIN
  IF lower(COALESCE(p_dispatch_mode, '')) <> 'scheduled' THEN
    RETURN false;
  END IF;

  -- Already locked or live — not Requested marketplace.
  IF p_driver_id IS NOT NULL OR p_confirmed_driver_id IS NOT NULL THEN
    RETURN false;
  END IF;

  IF v_status IN (
    'completed', 'cancelled', 'customer_cancelled', 'driver_cancelled',
    'no_show', 'expired', 'expired_no_driver',
    'en_route_to_pickup', 'in_progress', 'arrived', 'arrived_at_pickup'
  ) THEN
    RETURN false;
  END IF;

  -- Admin HELD stays invisible until Make Available / Broadcast / Assign.
  IF v_sched = 'admin_held' OR v_sched = '' THEN
    RETURN false;
  END IF;

  -- Published for Scheduled Jobs preconfirm and/or NRO waves.
  IF v_sched NOT IN (
    'scheduled', 'pending', 'broadcasting', 'awaiting_confirmation', 'dispatching'
  ) THEN
    RETURN false;
  END IF;

  IF p_scheduled_at IS NULL OR p_scheduled_at <= p_now THEN
    RETURN false;
  END IF;

  v_broadcast := p_scheduled_broadcast_at;
  IF v_broadcast IS NULL THEN
    -- Legacy NULL anchors: reconstruct policy clock from created_at.
    SELECT a.scheduled_broadcast_at
      INTO v_broadcast
    FROM public.compute_scheduled_dispatch_anchors(
      p_scheduled_at,
      COALESCE(p_created_at, p_now)
    ) a;
  END IF;

  RETURN v_broadcast IS NOT NULL AND v_broadcast <= p_now;
END;
$function$;

COMMENT ON FUNCTION public.scheduled_marketplace_is_open IS
  'True when a scheduled trip is visible on Driver Scheduled Jobs Requested (advance preconfirm). Requires leave-HELD publication (scheduled_broadcast_at due). Does not imply NRO Broadcast.';
