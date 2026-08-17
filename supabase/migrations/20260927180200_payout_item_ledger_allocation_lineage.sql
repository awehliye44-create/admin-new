-- Payout Ledger lineage: every payout item amount must map to eligible
-- PLATFORM_COLLECTED Driver Wallet Ledger entry IDs before execute / bank transfer.
-- Weekly items may keep trip_id null; allocations cannot be empty.
-- Failed/reversed items keep allocation rows (append-only). Retry cannot double-pay.

BEGIN;

CREATE OR REPLACE FUNCTION public.payout_item_status_releases_ledger_allocation(
  p_status text,
  p_execution_status text
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT upper(btrim(coalesce(p_status, ''))) IN (
        'CANCELLED', 'RELEASED', 'INELIGIBLE',
        'FAILED', 'REVERSED', 'RETURNED', 'INVALID_ORPHANED',
        'LEDGER_SYNC_FAILED', 'FAILED_RETRYABLE', 'FAILED_PERMANENT'
      )
      OR upper(btrim(coalesce(p_execution_status, ''))) IN (
        'CANCELLED', 'RELEASED', 'INELIGIBLE',
        'FAILED', 'REVERSED', 'RETURNED', 'INVALID_ORPHANED',
        'LEDGER_SYNC_FAILED', 'FAILED_RETRYABLE', 'FAILED_PERMANENT'
      );
$$;

CREATE OR REPLACE FUNCTION public.payout_ledger_type_is_payout_eligible(p_type text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT upper(btrim(coalesce(p_type, ''))) IN (
    'TRIP_EARNING_NET',
    'DRIVER_TIP_CREDIT',
    'TIP_CREDIT'
  );
$$;

CREATE OR REPLACE FUNCTION public.assert_payout_item_ledger_lineage(p_payout_item_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $function$
DECLARE
  v_item public.payout_items%ROWTYPE;
  v_alloc_count integer;
  v_alloc_sum integer;
  v_alloc record;
  v_ledger public.driver_wallet_ledger%ROWTYPE;
  v_model text;
  v_other integer;
BEGIN
  IF p_payout_item_id IS NULL THEN
    RAISE EXCEPTION 'PAYOUT_LINEAGE_MISSING: payout_item_id is required'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_item FROM public.payout_items WHERE id = p_payout_item_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT_LINEAGE_MISSING: payout item % not found', p_payout_item_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF coalesce(v_item.amount_pence, 0) <= 0 THEN
    RAISE EXCEPTION 'PAYOUT_LINEAGE_MISMATCH: payout item amount must be positive'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT count(*), coalesce(sum(a.amount_pence), 0)
    INTO v_alloc_count, v_alloc_sum
  FROM public.payout_item_ledger_allocations a
  WHERE a.payout_item_id = p_payout_item_id;

  IF v_alloc_count IS NULL OR v_alloc_count < 1 THEN
    RAISE EXCEPTION 'PAYOUT_LINEAGE_MISSING: payout item % has no ledger allocations', p_payout_item_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_alloc_sum <> v_item.amount_pence THEN
    RAISE EXCEPTION
      'PAYOUT_LINEAGE_MISMATCH: allocation total %p does not equal payout item %p',
      v_alloc_sum, v_item.amount_pence
      USING ERRCODE = 'check_violation';
  END IF;

  FOR v_alloc IN
    SELECT * FROM public.payout_item_ledger_allocations
    WHERE payout_item_id = p_payout_item_id
  LOOP
    IF v_alloc.amount_pence IS NULL OR v_alloc.amount_pence <= 0 THEN
      RAISE EXCEPTION 'PAYOUT_LINEAGE_MISMATCH: allocation amount must be positive'
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT * INTO v_ledger
    FROM public.driver_wallet_ledger
    WHERE id = v_alloc.ledger_entry_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PAYOUT_LINEAGE_MISSING: ledger entry % not found', v_alloc.ledger_entry_id
        USING ERRCODE = 'check_violation';
    END IF;

    IF v_ledger.driver_id IS DISTINCT FROM v_item.driver_id THEN
      RAISE EXCEPTION 'PAYOUT_LINEAGE_MISMATCH: ledger % belongs to a different driver', v_ledger.id
        USING ERRCODE = 'check_violation';
    END IF;

    IF NOT public.payout_ledger_type_is_payout_eligible(v_ledger.type) THEN
      RAISE EXCEPTION
        'PAYOUT_LINEAGE_MISMATCH: ledger type % is not payout-eligible',
        v_ledger.type
        USING ERRCODE = 'check_violation';
    END IF;

    IF v_ledger.related_trip_id IS NOT NULL THEN
      SELECT financial_model::text INTO v_model
      FROM public.trips
      WHERE id = v_ledger.related_trip_id;
      IF v_model IS NULL THEN
        RAISE EXCEPTION 'PAYOUT_LINEAGE_MISMATCH: allocated trip % is missing', v_ledger.related_trip_id
          USING ERRCODE = 'check_violation';
      END IF;
      IF v_model = 'DRIVER_COLLECTED_COMMISSION_WALLET' THEN
        RAISE EXCEPTION
          'FINANCIAL_MODEL_VIOLATION: Driver-Collected trip entries cannot enter Payout Ledger'
          USING ERRCODE = 'check_violation';
      END IF;
      IF v_model IS DISTINCT FROM 'PLATFORM_COLLECTED' THEN
        RAISE EXCEPTION
          'PAYOUT_LINEAGE_MISMATCH: trip-linked ledger % must belong to PLATFORM_COLLECTED',
          v_ledger.id
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;

    SELECT coalesce(sum(a.amount_pence), 0) INTO v_other
    FROM public.payout_item_ledger_allocations a
    JOIN public.payout_items pi ON pi.id = a.payout_item_id
    WHERE a.ledger_entry_id = v_ledger.id
      AND NOT public.payout_item_status_releases_ledger_allocation(pi.status, pi.execution_status);

    IF v_other > greatest(v_ledger.amount_pence, 0) THEN
      RAISE EXCEPTION
        'PAYOUT_LINEAGE_MISMATCH: ledger % allocated %p exceeds entry %p',
        v_ledger.id, v_other, v_ledger.amount_pence
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_payout_item_require_lineage_before_execute()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $function$
DECLARE
  v_new_status text := upper(btrim(coalesce(NEW.status, '')));
  v_new_exec text := upper(btrim(coalesce(NEW.execution_status, '')));
  v_execute boolean;
BEGIN
  v_execute := v_new_status IN (
      'RESERVING', 'RESERVED', 'SUBMITTING', 'SUBMITTED', 'COMPLETED', 'PAID', 'PROCESSING', 'SENT'
    )
    OR v_new_exec IN (
      'RESERVING', 'RESERVED', 'SUBMITTING', 'SUBMITTED', 'COMPLETED', 'PAID', 'PROCESSING', 'SENT'
    );
  IF v_execute THEN
    PERFORM public.assert_payout_item_ledger_lineage(NEW.id);
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_payout_item_require_lineage_before_execute ON public.payout_items;
CREATE TRIGGER trg_payout_item_require_lineage_before_execute
  BEFORE INSERT OR UPDATE OF status, execution_status ON public.payout_items
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_payout_item_require_lineage_before_execute();

CREATE OR REPLACE FUNCTION public.trg_payout_item_ledger_allocations_validate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $function$
DECLARE
  v_item public.payout_items%ROWTYPE;
  v_ledger public.driver_wallet_ledger%ROWTYPE;
  v_model text;
  v_other integer;
BEGIN
  IF NEW.payout_item_id IS NULL THEN
    RAISE EXCEPTION 'PAYOUT_LINEAGE_MISSING: allocation payout_item_id cannot be null'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.ledger_entry_id IS NULL THEN
    RAISE EXCEPTION 'PAYOUT_LINEAGE_MISSING: allocation ledger_entry_id cannot be null'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.amount_pence IS NULL OR NEW.amount_pence <= 0 THEN
    RAISE EXCEPTION 'PAYOUT_LINEAGE_MISMATCH: allocation amount must be positive'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_item FROM public.payout_items WHERE id = NEW.payout_item_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT_LINEAGE_MISSING: payout item % not found', NEW.payout_item_id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_ledger FROM public.driver_wallet_ledger WHERE id = NEW.ledger_entry_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT_LINEAGE_MISSING: ledger entry % not found', NEW.ledger_entry_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_ledger.driver_id IS DISTINCT FROM v_item.driver_id THEN
    RAISE EXCEPTION 'PAYOUT_LINEAGE_MISMATCH: ledger belongs to a different driver'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT public.payout_ledger_type_is_payout_eligible(v_ledger.type) THEN
    RAISE EXCEPTION
      'PAYOUT_LINEAGE_MISMATCH: ledger type % is not payout-eligible',
      v_ledger.type
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_ledger.related_trip_id IS NOT NULL THEN
    SELECT financial_model::text INTO v_model FROM public.trips WHERE id = v_ledger.related_trip_id;
    IF coalesce(v_model, '') = 'DRIVER_COLLECTED_COMMISSION_WALLET' THEN
      RAISE EXCEPTION
        'FINANCIAL_MODEL_VIOLATION: Driver-Collected trip entries cannot enter Payout Ledger'
        USING ERRCODE = 'check_violation';
    END IF;
    IF v_model IS DISTINCT FROM 'PLATFORM_COLLECTED' THEN
      RAISE EXCEPTION
        'PAYOUT_LINEAGE_MISMATCH: trip-linked ledger must belong to PLATFORM_COLLECTED'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  SELECT coalesce(sum(a.amount_pence), 0) INTO v_other
  FROM public.payout_item_ledger_allocations a
  JOIN public.payout_items pi ON pi.id = a.payout_item_id
  WHERE a.ledger_entry_id = NEW.ledger_entry_id
    AND a.id IS DISTINCT FROM NEW.id
    AND NOT public.payout_item_status_releases_ledger_allocation(pi.status, pi.execution_status);

  IF v_other + NEW.amount_pence > greatest(v_ledger.amount_pence, 0) THEN
    RAISE EXCEPTION
      'PAYOUT_LINEAGE_MISMATCH: ledger entry already allocated to a successful/reserved payout'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_payout_item_ledger_allocations_validate ON public.payout_item_ledger_allocations;
CREATE TRIGGER trg_payout_item_ledger_allocations_validate
  BEFORE INSERT ON public.payout_item_ledger_allocations
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_payout_item_ledger_allocations_validate();

CREATE OR REPLACE FUNCTION public.trg_payout_item_ledger_allocations_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'PAYOUT_LINEAGE_IMMUTABLE: payout_item_ledger_allocations cannot be updated or deleted'
    USING ERRCODE = 'check_violation';
END;
$function$;

DROP TRIGGER IF EXISTS trg_payout_item_ledger_allocations_no_update ON public.payout_item_ledger_allocations;
CREATE TRIGGER trg_payout_item_ledger_allocations_no_update
  BEFORE UPDATE ON public.payout_item_ledger_allocations
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_payout_item_ledger_allocations_immutable();

DROP TRIGGER IF EXISTS trg_payout_item_ledger_allocations_no_delete ON public.payout_item_ledger_allocations;
CREATE TRIGGER trg_payout_item_ledger_allocations_no_delete
  BEFORE DELETE ON public.payout_item_ledger_allocations
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_payout_item_ledger_allocations_immutable();

REVOKE ALL ON FUNCTION public.assert_payout_item_ledger_lineage(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assert_payout_item_ledger_lineage(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.payout_item_status_releases_ledger_allocation(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.payout_item_status_releases_ledger_allocation(text, text) TO service_role;

REVOKE ALL ON FUNCTION public.payout_ledger_type_is_payout_eligible(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.payout_ledger_type_is_payout_eligible(text) TO service_role;

COMMIT;
