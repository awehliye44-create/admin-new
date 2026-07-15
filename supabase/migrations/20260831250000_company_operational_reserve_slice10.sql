-- Slice 10 — Operational / Refund Reserve SSOT
-- Config table + audit. Configuration never moves money.
-- Absence of ACTIVE policy = OPERATIONAL_RESERVE_NOT_CONFIGURED (fail-closed).
-- No ACTIVE seed — leave production NOT_CONFIGURED until explicit activation.

CREATE TABLE IF NOT EXISTS public.company_operational_refund_reserves (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_area_id uuid NULL REFERENCES public.service_areas(id) ON DELETE CASCADE,
  currency text NOT NULL DEFAULT 'GBP',
  reserve_mode text NOT NULL
    CHECK (reserve_mode = ANY (ARRAY['FIXED_AMOUNT', 'PERCENTAGE']::text[])),
  reserve_amount_pence integer NULL
    CHECK (reserve_amount_pence IS NULL OR reserve_amount_pence >= 0),
  reserve_percentage_bps integer NULL
    CHECK (reserve_percentage_bps IS NULL OR (reserve_percentage_bps >= 0 AND reserve_percentage_bps <= 100000)),
  minimum_reserve_pence integer NOT NULL DEFAULT 0
    CHECK (minimum_reserve_pence >= 0),
  effective_from timestamptz NULL,
  effective_to timestamptz NULL,
  status text NOT NULL DEFAULT 'DRAFT'
    CHECK (status = ANY (ARRAY['DRAFT', 'ACTIVE', 'DISABLED']::text[])),
  created_by uuid NULL,
  approved_by uuid NULL,
  activated_at timestamptz NULL,
  disabled_at timestamptz NULL,
  audit_note text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT company_operational_refund_reserves_mode_shape CHECK (
    (reserve_mode = 'FIXED_AMOUNT' AND reserve_amount_pence IS NOT NULL)
    OR (reserve_mode = 'PERCENTAGE' AND reserve_percentage_bps IS NOT NULL)
  ),
  CONSTRAINT company_operational_refund_reserves_currency_len CHECK (char_length(currency) = 3)
);

-- At most one ACTIVE policy per (service_area_id, currency). NULL service_area = fleet-wide.
CREATE UNIQUE INDEX IF NOT EXISTS uq_company_ops_reserve_active_sa_ccy
  ON public.company_operational_refund_reserves (
    COALESCE(service_area_id, '00000000-0000-0000-0000-000000000000'::uuid),
    upper(currency)
  )
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS idx_company_ops_reserve_sa_status
  ON public.company_operational_refund_reserves (service_area_id, status, currency);

CREATE TABLE IF NOT EXISTS public.company_operational_reserve_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reserve_id uuid NULL REFERENCES public.company_operational_refund_reserves(id) ON DELETE SET NULL,
  action text NOT NULL
    CHECK (action = ANY (ARRAY[
      'SAVE_DRAFT', 'ACTIVATE', 'DISABLE', 'UPDATE_DRAFT', 'DELETE_DRAFT'
    ]::text[])),
  actor_id uuid NULL,
  from_status text NULL,
  to_status text NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  note text NULL,
  -- Explicit: config audit never records wallet / reservation / provider payment movement
  money_moved boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_company_ops_reserve_audit_reserve_created
  ON public.company_operational_reserve_audit (reserve_id, created_at DESC);

ALTER TABLE public.company_operational_refund_reserves ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_operational_reserve_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS company_ops_reserve_admin_all ON public.company_operational_refund_reserves;
CREATE POLICY company_ops_reserve_admin_all
  ON public.company_operational_refund_reserves
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));

DROP POLICY IF EXISTS company_ops_reserve_service_role ON public.company_operational_refund_reserves;
CREATE POLICY company_ops_reserve_service_role
  ON public.company_operational_refund_reserves
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS company_ops_reserve_audit_admin_all ON public.company_operational_reserve_audit;
CREATE POLICY company_ops_reserve_audit_admin_all
  ON public.company_operational_reserve_audit
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));

DROP POLICY IF EXISTS company_ops_reserve_audit_service_role ON public.company_operational_reserve_audit;
CREATE POLICY company_ops_reserve_audit_service_role
  ON public.company_operational_reserve_audit
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE public.company_operational_refund_reserves IS
  'Slice 10 Operational/Refund Reserve SSOT. Only ACTIVE rows unlock final_company_available. Config does not move money. Absence of ACTIVE = OPERATIONAL_RESERVE_NOT_CONFIGURED (fail-closed; never invent £0).';

COMMENT ON TABLE public.company_operational_reserve_audit IS
  'Activation/disable/draft audit for operational reserves. money_moved always false.';

-- Resolve ACTIVE reserve policy for a service area + currency (backend SSOT only).
CREATE OR REPLACE FUNCTION public.resolve_active_company_operational_reserve(
  p_service_area_id uuid DEFAULT NULL,
  p_currency text DEFAULT 'GBP',
  p_as_of timestamptz DEFAULT now()
)
RETURNS TABLE (
  id uuid,
  service_area_id uuid,
  currency text,
  reserve_mode text,
  reserve_amount_pence integer,
  reserve_percentage_bps integer,
  minimum_reserve_pence integer,
  effective_from timestamptz,
  effective_to timestamptz,
  status text,
  created_by uuid,
  approved_by uuid,
  activated_at timestamptz,
  disabled_at timestamptz,
  audit_note text,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ccy text := upper(trim(coalesce(p_currency, 'GBP')));
BEGIN
  RETURN QUERY
  SELECT
    r.id,
    r.service_area_id,
    r.currency,
    r.reserve_mode,
    r.reserve_amount_pence,
    r.reserve_percentage_bps,
    r.minimum_reserve_pence,
    r.effective_from,
    r.effective_to,
    r.status,
    r.created_by,
    r.approved_by,
    r.activated_at,
    r.disabled_at,
    r.audit_note,
    r.created_at,
    r.updated_at
  FROM public.company_operational_refund_reserves r
  WHERE r.status = 'ACTIVE'
    AND upper(r.currency) = v_ccy
    AND (
      r.service_area_id IS NOT DISTINCT FROM p_service_area_id
      OR (p_service_area_id IS NOT NULL AND r.service_area_id IS NULL)
    )
    AND (r.effective_from IS NULL OR r.effective_from <= p_as_of)
    AND (r.effective_to IS NULL OR r.effective_to >= p_as_of)
  ORDER BY
    CASE WHEN r.service_area_id IS NOT NULL THEN 0 ELSE 1 END,
    r.activated_at DESC NULLS LAST,
    r.updated_at DESC
  LIMIT 1;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_active_company_operational_reserve(uuid, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_active_company_operational_reserve(uuid, text, timestamptz)
  TO authenticated, service_role;

-- Prefer SA-specific ACTIVE; fall back to fleet-wide (NULL SA) for same currency.
CREATE OR REPLACE FUNCTION public.resolve_active_company_operational_reserve_prefer_sa(
  p_service_area_id uuid DEFAULT NULL,
  p_currency text DEFAULT 'GBP',
  p_as_of timestamptz DEFAULT now()
)
RETURNS SETOF public.company_operational_refund_reserves
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ccy text := upper(trim(coalesce(p_currency, 'GBP')));
  v_row public.company_operational_refund_reserves%ROWTYPE;
BEGIN
  IF p_service_area_id IS NOT NULL THEN
    SELECT * INTO v_row
    FROM public.company_operational_refund_reserves r
    WHERE r.status = 'ACTIVE'
      AND upper(r.currency) = v_ccy
      AND r.service_area_id = p_service_area_id
      AND (r.effective_from IS NULL OR r.effective_from <= p_as_of)
      AND (r.effective_to IS NULL OR r.effective_to >= p_as_of)
    ORDER BY r.activated_at DESC NULLS LAST, r.updated_at DESC
    LIMIT 1;
    IF FOUND THEN
      RETURN NEXT v_row;
      RETURN;
    END IF;
  END IF;

  SELECT * INTO v_row
  FROM public.company_operational_refund_reserves r
  WHERE r.status = 'ACTIVE'
    AND upper(r.currency) = v_ccy
    AND r.service_area_id IS NULL
    AND (r.effective_from IS NULL OR r.effective_from <= p_as_of)
    AND (r.effective_to IS NULL OR r.effective_to >= p_as_of)
  ORDER BY r.activated_at DESC NULLS LAST, r.updated_at DESC
  LIMIT 1;
  IF FOUND THEN
    RETURN NEXT v_row;
  END IF;
  RETURN;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_active_company_operational_reserve_prefer_sa(uuid, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_active_company_operational_reserve_prefer_sa(uuid, text, timestamptz)
  TO authenticated, service_role;
