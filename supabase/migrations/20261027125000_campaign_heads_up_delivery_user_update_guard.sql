-- Authenticated apps may only advance own delivery rows to opened/tapped/dismissed.
-- Service role (edge dispatch) has no auth.uid() and retains full write freedom.

CREATE OR REPLACE FUNCTION public.enforce_campaign_heads_up_delivery_user_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  -- Edge / service-role / non-user sessions own pending → delivered / failed.
  -- Do NOT key off auth.role() alone — some service paths leave it unset.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF auth.uid() IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'campaign_heads_up_delivery_forbidden';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.campaign_id IS DISTINCT FROM OLD.campaign_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.user_app IS DISTINCT FROM OLD.user_app
     OR NEW.dedupe_key IS DISTINCT FROM OLD.dedupe_key
     OR NEW.delivered_at IS DISTINCT FROM OLD.delivered_at
     OR NEW.failed_at IS DISTINCT FROM OLD.failed_at
     OR NEW.failure_reason IS DISTINCT FROM OLD.failure_reason
     OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'campaign_heads_up_delivery_immutable_fields';
  END IF;

  IF NEW.status NOT IN ('opened', 'tapped', 'dismissed') THEN
    RAISE EXCEPTION 'campaign_heads_up_delivery_invalid_status';
  END IF;

  IF OLD.status NOT IN ('delivered', 'opened', 'tapped') THEN
    RAISE EXCEPTION 'campaign_heads_up_delivery_invalid_from_status';
  END IF;

  IF NEW.status = 'opened' AND OLD.status NOT IN ('delivered', 'opened') THEN
    RAISE EXCEPTION 'campaign_heads_up_delivery_invalid_transition';
  END IF;
  IF NEW.status = 'dismissed' AND OLD.status NOT IN ('delivered', 'opened') THEN
    RAISE EXCEPTION 'campaign_heads_up_delivery_invalid_transition';
  END IF;
  IF NEW.status = 'tapped' AND OLD.status NOT IN ('delivered', 'opened', 'tapped') THEN
    RAISE EXCEPTION 'campaign_heads_up_delivery_invalid_transition';
  END IF;

  -- Only the stamp for the target status may change.
  IF NEW.status = 'opened'
     AND (
       NEW.tapped_at IS DISTINCT FROM OLD.tapped_at
       OR NEW.dismissed_at IS DISTINCT FROM OLD.dismissed_at
     )
  THEN
    RAISE EXCEPTION 'campaign_heads_up_delivery_invalid_stamps';
  END IF;
  IF NEW.status = 'tapped'
     AND (
       NEW.opened_at IS DISTINCT FROM OLD.opened_at
       OR NEW.dismissed_at IS DISTINCT FROM OLD.dismissed_at
     )
  THEN
    RAISE EXCEPTION 'campaign_heads_up_delivery_invalid_stamps';
  END IF;
  IF NEW.status = 'dismissed'
     AND (
       NEW.opened_at IS DISTINCT FROM OLD.opened_at
       OR NEW.tapped_at IS DISTINCT FROM OLD.tapped_at
     )
  THEN
    RAISE EXCEPTION 'campaign_heads_up_delivery_invalid_stamps';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_campaign_heads_up_delivery_user_update
  ON public.campaign_heads_up_deliveries;
CREATE TRIGGER trg_enforce_campaign_heads_up_delivery_user_update
  BEFORE UPDATE ON public.campaign_heads_up_deliveries
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_campaign_heads_up_delivery_user_update();

-- Tighten RLS WITH CHECK so clients cannot claim delivered/failed/pending.
DROP POLICY IF EXISTS "Users update own campaign deliveries" ON public.campaign_heads_up_deliveries;
CREATE POLICY "Users update own campaign deliveries"
  ON public.campaign_heads_up_deliveries
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (
    auth.uid() = user_id
    AND status IN ('opened', 'tapped', 'dismissed')
  );
