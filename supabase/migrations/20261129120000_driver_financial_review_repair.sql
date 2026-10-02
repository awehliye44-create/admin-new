-- Admin Driver Financial Review & Repair — preview tokens + immutable audit.
-- DRAFT ONLY: do not apply until repair-control approval.
-- No Revolut / payout / scheduler / direct unfreeze writes.

BEGIN;

CREATE TABLE IF NOT EXISTS public.driver_financial_repair_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repair_token uuid NOT NULL UNIQUE,
  driver_id uuid NOT NULL REFERENCES public.drivers(id),
  trip_id uuid NOT NULL REFERENCES public.trips(id),
  preview_hash text NOT NULL,
  classification text NOT NULL,
  preview_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'PREVIEWED'
    CHECK (status = ANY (ARRAY['PREVIEWED'::text, 'APPLIED'::text, 'EXPIRED'::text, 'BLOCKED'::text])),
  calculation_version text NOT NULL,
  created_by_admin_id uuid NOT NULL,
  applied_by_admin_id uuid,
  apply_reason text,
  apply_result jsonb,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  CONSTRAINT driver_financial_repair_requests_reason_len
    CHECK (apply_reason IS NULL OR (char_length(apply_reason) BETWEEN 3 AND 500))
);

CREATE UNIQUE INDEX IF NOT EXISTS driver_financial_repair_requests_idempotency_uidx
  ON public.driver_financial_repair_requests (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS driver_financial_repair_requests_driver_idx
  ON public.driver_financial_repair_requests (driver_id, created_at DESC);

CREATE INDEX IF NOT EXISTS driver_financial_repair_requests_trip_idx
  ON public.driver_financial_repair_requests (trip_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.driver_financial_repair_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  repair_token uuid NOT NULL,
  idempotency_key text,
  preview_hash text,
  driver_id uuid REFERENCES public.drivers(id),
  trip_id uuid REFERENCES public.trips(id),
  admin_user_id uuid NOT NULL,
  reason text,
  calculation_version text NOT NULL,
  before_state jsonb,
  after_state jsonb,
  source_evidence jsonb,
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT driver_financial_repair_audit_event_type_check
    CHECK (event_type = ANY (ARRAY[
      'DRIVER_FINANCIAL_REPAIR_PREVIEWED'::text,
      'EXPECTED_STAMP_RESTORED'::text,
      'WALLET_CORRECTION_APPENDED'::text,
      'RECONCILIATION_RECOMPUTED'::text,
      'FALSE_FREEZE_CLEARED'::text,
      'FINANCIAL_REPAIR_BLOCKED'::text
    ]))
);

CREATE INDEX IF NOT EXISTS driver_financial_repair_audit_token_idx
  ON public.driver_financial_repair_audit (repair_token, created_at);

CREATE INDEX IF NOT EXISTS driver_financial_repair_audit_driver_idx
  ON public.driver_financial_repair_audit (driver_id, created_at DESC);

-- Append-only wallet correction idempotency (repair path; separate from manual adj).
CREATE UNIQUE INDEX IF NOT EXISTS driver_wallet_ledger_financial_repair_idempotency_uidx
  ON public.driver_wallet_ledger (provider_transfer_id)
  WHERE provider_transfer_id LIKE 'dw_fin_repair:%';

ALTER TABLE public.driver_financial_repair_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.driver_financial_repair_audit ENABLE ROW LEVEL SECURITY;

-- Finance staff read; no authenticated client writes (service_role / Edge only).
DROP POLICY IF EXISTS driver_financial_repair_requests_finance_read ON public.driver_financial_repair_requests;
CREATE POLICY driver_financial_repair_requests_finance_read
  ON public.driver_financial_repair_requests
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.staff_profiles sp
      WHERE sp.user_id = auth.uid()
        AND sp.is_active = true
        AND sp.role = ANY (ARRAY[
          'super_admin'::public.staff_role,
          'admin'::public.staff_role,
          'finance_manager'::public.staff_role
        ])
    )
  );

DROP POLICY IF EXISTS driver_financial_repair_audit_finance_read ON public.driver_financial_repair_audit;
CREATE POLICY driver_financial_repair_audit_finance_read
  ON public.driver_financial_repair_audit
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.staff_profiles sp
      WHERE sp.user_id = auth.uid()
        AND sp.is_active = true
        AND sp.role = ANY (ARRAY[
          'super_admin'::public.staff_role,
          'admin'::public.staff_role,
          'finance_manager'::public.staff_role
        ])
    )
  );

REVOKE ALL ON public.driver_financial_repair_requests FROM PUBLIC;
REVOKE ALL ON public.driver_financial_repair_audit FROM PUBLIC;
GRANT SELECT ON public.driver_financial_repair_requests TO authenticated;
GRANT SELECT ON public.driver_financial_repair_audit TO authenticated;
GRANT ALL ON public.driver_financial_repair_requests TO service_role;
GRANT ALL ON public.driver_financial_repair_audit TO service_role;

-- Deny direct client INSERT/UPDATE/DELETE (immutable audit + Edge-only mutate).
CREATE OR REPLACE FUNCTION public.deny_client_driver_financial_repair_mutate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF current_setting('role', true) = 'service_role'
     OR current_user = 'service_role'
     OR session_user = 'service_role' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'driver financial repair tables are Edge/service_role only'
    USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_deny_client_driver_financial_repair_requests
  ON public.driver_financial_repair_requests;
CREATE TRIGGER trg_deny_client_driver_financial_repair_requests
  BEFORE INSERT OR UPDATE OR DELETE ON public.driver_financial_repair_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.deny_client_driver_financial_repair_mutate();

DROP TRIGGER IF EXISTS trg_deny_client_driver_financial_repair_audit
  ON public.driver_financial_repair_audit;
CREATE TRIGGER trg_deny_client_driver_financial_repair_audit
  BEFORE INSERT OR UPDATE OR DELETE ON public.driver_financial_repair_audit
  FOR EACH ROW
  EXECUTE FUNCTION public.deny_client_driver_financial_repair_mutate();

-- Audit is append-only even for service_role updates/deletes of historical rows.
CREATE OR REPLACE FUNCTION public.deny_driver_financial_repair_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'driver_financial_repair_audit is append-only'
    USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_driver_financial_repair_audit_append_only
  ON public.driver_financial_repair_audit;
CREATE TRIGGER trg_driver_financial_repair_audit_append_only
  BEFORE UPDATE OR DELETE ON public.driver_financial_repair_audit
  FOR EACH ROW
  EXECUTE FUNCTION public.deny_driver_financial_repair_audit_mutation();

-- Session-level advisory lock for Apply serialization (Edge fail-closed).
-- Uses pg_advisory_lock (session), not xact — Edge HTTP calls are separate transactions.
CREATE OR REPLACE FUNCTION public.admin_driver_financial_repair_lock(
  p_driver_id uuid,
  p_acquire boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_k1 int;
  v_k2 int;
BEGIN
  IF p_driver_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'DRIVER_REQUIRED');
  END IF;

  -- Finance / service-role only (Edge uses service_role after requireFinanceExecutionAuth).
  IF current_setting('role', true) IS DISTINCT FROM 'service_role'
     AND session_user IS DISTINCT FROM 'service_role'
     AND current_user IS DISTINCT FROM 'service_role' THEN
    BEGIN
      PERFORM public.assert_finance_payout_ledger_access();
    EXCEPTION WHEN OTHERS THEN
      RETURN jsonb_build_object('ok', false, 'error_code', 'PERMISSION_DENIED');
    END;
  END IF;

  v_k1 := ('x' || substr(md5('driver_financial_repair:' || p_driver_id::text), 1, 8))::bit(32)::int;
  v_k2 := ('x' || substr(md5('driver_financial_repair:' || p_driver_id::text), 9, 8))::bit(32)::int;

  IF p_acquire THEN
    PERFORM pg_advisory_lock(v_k1, v_k2);
    RETURN jsonb_build_object('ok', true, 'acquired', true);
  END IF;

  PERFORM pg_advisory_unlock(v_k1, v_k2);
  RETURN jsonb_build_object('ok', true, 'acquired', false);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_driver_financial_repair_lock(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_driver_financial_repair_lock(uuid, boolean) TO service_role;

COMMIT;
