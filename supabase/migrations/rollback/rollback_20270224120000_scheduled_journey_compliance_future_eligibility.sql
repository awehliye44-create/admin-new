-- Rollback: scheduled journey future compliance eligibility
-- Restores document recalc/trigger without scheduled release side-effects.
-- Does NOT rewrite accept_scheduled_ride / admin_assign bodies (re-apply prior
-- migrations or restore from backup if a full function restore is required).

DROP TRIGGER IF EXISTS trg_release_scheduled_on_driver_account_change ON public.drivers;
DROP FUNCTION IF EXISTS public.release_scheduled_on_driver_account_change();
DROP FUNCTION IF EXISTS public.reconcile_scheduled_journey_compliance(integer);
DROP FUNCTION IF EXISTS public.release_ineligible_scheduled_assignments_for_driver(uuid);
DROP FUNCTION IF EXISTS public.release_scheduled_assignment_for_compliance(uuid, uuid, text, boolean);
DROP FUNCTION IF EXISTS public.driver_eligible_for_scheduled_journey(uuid, uuid);
DROP FUNCTION IF EXISTS public.assert_driver_scheduled_journey_compliance(uuid, uuid);
DROP FUNCTION IF EXISTS public.check_driver_documents_valid_through(uuid, timestamptz);

-- Restore recalculate / document status trigger without release side-effect
-- (body matches 20261231184000_force_offline_clear_intent_on_document_ineligibility).
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
