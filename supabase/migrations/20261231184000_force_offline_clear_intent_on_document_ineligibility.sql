-- When required documents are rejected / expired / otherwise unapproved,
-- clear BOTH is_online AND driver_online_intent. Clearing effective online
-- alone left sticky intent → Driver Home stayed Online/Reconnecting while
-- the documents banner correctly said replacements were required (MK0006).

CREATE OR REPLACE FUNCTION public.force_driver_offline_for_document_ineligibility(
  p_driver_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_driver public.drivers%ROWTYPE;
  v_from_intent boolean;
  v_from_online boolean;
BEGIN
  IF p_driver_id IS NULL THEN
    RETURN;
  END IF;

  SELECT * INTO v_driver
  FROM public.drivers
  WHERE id = p_driver_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  v_from_intent := COALESCE(v_driver.driver_online_intent, false);
  v_from_online := COALESCE(v_driver.is_online, false);

  IF NOT v_from_intent AND NOT v_from_online AND v_driver.online_since IS NULL THEN
    RETURN;
  END IF;

  PERFORM public.allow_driver_availability_write();

  UPDATE public.drivers
  SET
    is_online = false,
    driver_online_intent = false,
    online_since = NULL,
    updated_at = now()
  WHERE id = p_driver_id;

  INSERT INTO public.driver_presence (
    driver_id,
    status,
    presence_health,
    offline_reason,
    last_offline_at,
    updated_at
  ) VALUES (
    p_driver_id,
    'offline',
    'offline',
    'documents_ineligible',
    now(),
    now()
  )
  ON CONFLICT (driver_id) DO UPDATE SET
    status = 'offline',
    presence_health = 'offline',
    offline_reason = 'documents_ineligible',
    last_offline_at = now(),
    updated_at = now();

  PERFORM public.log_driver_availability_event(
    p_driver_id,
    'force_offline',
    'documents_ineligible',
    v_from_intent,
    false,
    v_from_online,
    false,
    jsonb_build_object('source', 'force_driver_offline_for_document_ineligibility')
  );
END;
$fn$;

COMMENT ON FUNCTION public.force_driver_offline_for_document_ineligibility(uuid) IS
  'Clear online intent + effective online when document compliance is lost. Does not delete push tokens.';

REVOKE ALL ON FUNCTION public.force_driver_offline_for_document_ineligibility(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.force_driver_offline_for_document_ineligibility(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.force_driver_offline_for_document_ineligibility(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.recalculate_driver_documents_approved_internal(p_driver_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_approved boolean;
BEGIN
  IF p_driver_id IS NULL THEN
    RETURN false;
  END IF;

  v_approved := public.check_driver_documents_approved(p_driver_id);

  UPDATE public.drivers d
  SET
    documents_approved = v_approved,
    onboarding_complete = v_approved,
    updated_at = now()
  WHERE d.id = p_driver_id
    AND (
      d.documents_approved IS DISTINCT FROM v_approved
      OR d.onboarding_complete IS DISTINCT FROM v_approved
    );

  -- Soft-block: clear intent + effective online when compliance is lost.
  IF v_approved = false THEN
    PERFORM public.force_driver_offline_for_document_ineligibility(p_driver_id);
  END IF;

  RETURN v_approved;
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_driver_document_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_driver_id uuid := COALESCE(NEW.driver_id, OLD.driver_id);
  v_approved boolean;
BEGIN
  IF v_driver_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  v_approved := public.check_driver_documents_approved(v_driver_id);

  UPDATE public.drivers
  SET
    documents_approved = v_approved,
    onboarding_complete = v_approved,
    updated_at = now()
  WHERE id = v_driver_id
    AND (
      documents_approved IS DISTINCT FROM v_approved
      OR onboarding_complete IS DISTINCT FROM v_approved
    );

  IF v_approved = false THEN
    PERFORM public.force_driver_offline_for_document_ineligibility(v_driver_id);
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_online_eligibility()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.is_online = true AND (OLD.is_online IS DISTINCT FROM true) THEN
    IF NEW.approval_status != 'approved' OR NEW.documents_approved != true
       OR lower(COALESCE(NEW.driver_status::text, '')) <> 'active' THEN
      PERFORM public.allow_driver_availability_write();
      NEW.is_online := false;
      NEW.driver_online_intent := false;
      NEW.online_since := NULL;
    END IF;
  END IF;

  -- Docs / approval / status loss: clear sticky intent (not effective-only).
  IF (NEW.approval_status != 'approved'
      OR NEW.documents_approved != true
      OR lower(COALESCE(NEW.driver_status::text, '')) <> 'active') THEN
    IF NEW.is_online IS DISTINCT FROM false
       OR NEW.driver_online_intent IS DISTINCT FROM false
       OR NEW.online_since IS NOT NULL THEN
      PERFORM public.allow_driver_availability_write();
      NEW.is_online := false;
      NEW.driver_online_intent := false;
      NEW.online_since := NULL;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.enforce_online_eligibility() IS
  'Keep drivers offline when approval/docs/status block eligibility. Clears driver_online_intent so Home cannot stay Online/Reconnecting.';

-- Repair sticky intent left by the previous effective-only soft-block.
SELECT public.allow_driver_availability_write();
UPDATE public.drivers d
SET
  is_online = false,
  driver_online_intent = false,
  online_since = NULL,
  updated_at = now()
WHERE d.documents_approved IS DISTINCT FROM true
  AND (
    COALESCE(d.is_online, false) = true
    OR COALESCE(d.driver_online_intent, false) = true
    OR d.online_since IS NOT NULL
  );

UPDATE public.driver_presence p
SET
  status = 'offline',
  presence_health = 'offline',
  offline_reason = 'documents_ineligible',
  last_offline_at = now(),
  updated_at = now()
FROM public.drivers d
WHERE p.driver_id = d.id
  AND d.documents_approved IS DISTINCT FROM true
  AND (
    p.status IS DISTINCT FROM 'offline'
    OR COALESCE(p.offline_reason, '') IS DISTINCT FROM 'documents_ineligible'
  );
