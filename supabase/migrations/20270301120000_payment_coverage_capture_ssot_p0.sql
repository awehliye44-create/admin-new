-- Stage A — Additive Payment Coverage & Capture SSOT schema.
-- Compatible with existing production Edge functions (no strict enforcement).
-- Strict trip-mirror trigger + require_financial_op_claim are Stage D
-- (see 20270301130000_payment_ssot_cutover_stage_d_strict.sql).
-- Does NOT mutate historical financial amounts (MK-260926-006 unchanged).
-- Do NOT apply to production until cutover approval.

-- Cutover control (single row). Stage A defaults: soft enforcement off.
CREATE TABLE IF NOT EXISTS public.payment_ssot_cutover (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  stage text NOT NULL DEFAULT 'A'
    CHECK (stage IN ('A', 'B', 'C', 'D', 'E')),
  require_financial_op_claim boolean NOT NULL DEFAULT false,
  strict_trip_capture_mirror boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.payment_ssot_cutover (id, stage, require_financial_op_claim, strict_trip_capture_mirror)
VALUES (1, 'A', false, false)
ON CONFLICT (id) DO NOTHING;

REVOKE ALL ON TABLE public.payment_ssot_cutover FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.payment_ssot_cutover TO service_role;
GRANT UPDATE ON TABLE public.payment_ssot_cutover TO service_role;

-- ── Session capture request vs confirm (authoritative split) ───────────────
ALTER TABLE public.payment_sessions
  ADD COLUMN IF NOT EXISTS capture_requested_pence integer,
  ADD COLUMN IF NOT EXISTS capture_confirmed_pence integer,
  ADD COLUMN IF NOT EXISTS capture_confirmation_state text,
  ADD COLUMN IF NOT EXISTS financial_operation_fence uuid;

COMMENT ON COLUMN public.payment_sessions.capture_requested_pence IS
  'Requested capture amount only — never proof of money taken.';
COMMENT ON COLUMN public.payment_sessions.capture_confirmed_pence IS
  'Provider-verified captured amount only (gross). Distinct from refunds/net.';
COMMENT ON COLUMN public.payment_sessions.capture_confirmation_state IS
  'CAPTURE_REQUESTED|CAPTURE_PENDING|CAPTURE_UNKNOWN|PARTIALLY_CAPTURED|FULLY_CAPTURED|CAPTURE_FAILED|RECOVERY_REQUIRED';

-- Project existing verified captures into capture_confirmed_pence (no money move).
UPDATE public.payment_sessions ps
SET
  capture_confirmed_pence = ps.captured_amount_pence,
  capture_confirmation_state = CASE
    WHEN COALESCE(ps.captured_amount_pence, 0) > 0
      AND upper(COALESCE(ps.provider_state, '')) IN ('COMPLETED', 'CAPTURED')
      AND ps.provider_state_verified_at IS NOT NULL
    THEN 'FULLY_CAPTURED'
    WHEN COALESCE(ps.captured_amount_pence, 0) > 0
    THEN 'CAPTURE_UNKNOWN'
    ELSE capture_confirmation_state
  END
WHERE ps.capture_confirmed_pence IS NULL
  AND COALESCE(ps.captured_amount_pence, 0) > 0;

-- ── Immutable payable snapshots ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.payment_payable_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
  version integer NOT NULL,
  source text NOT NULL
    CHECK (source IN (
      'booking', 'completion', 'modification', 'negotiation_commit',
      'force_complete', 'tip_finalize', 'admin_capture', 'composition', 'recovery'
    )),
  gross_fare_pence integer NOT NULL DEFAULT 0,
  modification_pence integer NOT NULL DEFAULT 0,
  waiting_pence integer NOT NULL DEFAULT 0,
  discount_pence integer NOT NULL DEFAULT 0,
  airport_pass_through_pence integer NOT NULL DEFAULT 0,
  tip_pence integer NOT NULL DEFAULT 0,
  receivables_pence integer NOT NULL DEFAULT 0,
  total_payable_pence integer NOT NULL,
  waiting_basis text NOT NULL DEFAULT 'columns'
    CHECK (waiting_basis IN ('columns', 'included_in_fare', 'none')),
  currency text NOT NULL DEFAULT 'GBP',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (trip_id, version)
);

CREATE INDEX IF NOT EXISTS payment_payable_snapshots_trip_id_idx
  ON public.payment_payable_snapshots (trip_id, version DESC);

COMMENT ON TABLE public.payment_payable_snapshots IS
  'Immutable versioned final payable for a financial operation. Waiting counted exactly once via waiting_basis.';

-- ── Durable financial operations (claim + fence + logical uniqueness) ──────
CREATE TABLE IF NOT EXISTS public.payment_financial_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id text NOT NULL UNIQUE,
  fence uuid NOT NULL,
  payment_session_id uuid NOT NULL REFERENCES public.payment_sessions(id) ON DELETE CASCADE,
  trip_id uuid REFERENCES public.trips(id) ON DELETE SET NULL,
  op_type text NOT NULL
    CHECK (op_type IN ('INCREMENT', 'CAPTURE', 'RECONCILE', 'RELEASE', 'SETTLE')),
  logical_idempotency_key text NOT NULL,
  provider_idempotency_key text,
  state text NOT NULL,
  payable_snapshot_id uuid REFERENCES public.payment_payable_snapshots(id) ON DELETE SET NULL,
  requested_amount_pence integer,
  provider_confirmed_amount_pence integer,
  provider_order_id text,
  merchant_account_ref text,
  currency text NOT NULL DEFAULT 'GBP',
  lease_expires_at timestamptz NOT NULL,
  provider_post_dispatched_at timestamptz,
  provider_post_inflight boolean NOT NULL DEFAULT false,
  last_provider_http_status integer,
  last_provider_correlation_id text,
  decline_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One active logical operation per session+type+key (database-enforced).
CREATE UNIQUE INDEX IF NOT EXISTS payment_financial_operations_logical_active_uidx
  ON public.payment_financial_operations (payment_session_id, op_type, logical_idempotency_key)
  WHERE state NOT IN (
    'COVER_CONFIRMED',
    'INCREMENT_DECLINED',
    'FULLY_CAPTURED',
    'PARTIALLY_CAPTURED',
    'CAPTURE_FAILED',
    'SETTLED',
    'SETTLED_PARTIAL',
    'CANCELLED',
    'SUPERSEDED'
  );

-- At most one active mutating claim per session (increment/capture/release).
CREATE UNIQUE INDEX IF NOT EXISTS payment_financial_operations_session_active_claim_uidx
  ON public.payment_financial_operations (payment_session_id)
  WHERE op_type IN ('INCREMENT', 'CAPTURE', 'RELEASE')
    AND state IN (
      'INCREMENT_REQUESTED',
      'INCREMENT_PENDING',
      'INCREMENT_UNKNOWN',
      'CAPTURE_REQUESTED',
      'CAPTURE_PENDING',
      'CAPTURE_UNKNOWN',
      'RECONCILING'
    )
    AND provider_post_inflight = true;

CREATE INDEX IF NOT EXISTS payment_financial_operations_session_state_idx
  ON public.payment_financial_operations (payment_session_id, state);

-- ── Diagnostics (sanitised) ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.payment_financial_events (
  id bigserial PRIMARY KEY,
  payment_session_id uuid REFERENCES public.payment_sessions(id) ON DELETE SET NULL,
  trip_id uuid,
  operation_id uuid REFERENCES public.payment_financial_operations(id) ON DELETE SET NULL,
  execution_id text,
  fence uuid,
  op_type text,
  event_type text NOT NULL,
  http_status integer,
  provider_correlation_id text,
  requested_amount_pence integer,
  provider_confirmed_amount_pence integer,
  provider_response_state text,
  decline_code text,
  idempotency_reference text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payment_financial_events_session_idx
  ON public.payment_financial_events (payment_session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS payment_financial_events_execution_idx
  ON public.payment_financial_events (execution_id);

COMMENT ON TABLE public.payment_financial_events IS
  'Sanitised payment diagnostics. Never store credentials, PAN, tokens, or wallet payloads.';

-- Detail must not contain forbidden keys (best-effort trigger).
CREATE OR REPLACE FUNCTION public.payment_financial_events_sanitize_detail()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  forbidden text[] := ARRAY[
    'password', 'secret', 'token', 'authorization', 'pan', 'card_number',
    'cvv', 'cvc', 'payment_method_token', 'client_secret', 'refresh_token'
  ];
  k text;
BEGIN
  IF NEW.detail IS NULL THEN
    NEW.detail := '{}'::jsonb;
  END IF;
  FOREACH k IN ARRAY forbidden LOOP
    IF NEW.detail ? k THEN
      NEW.detail := NEW.detail - k;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_payment_financial_events_sanitize ON public.payment_financial_events;
CREATE TRIGGER trg_payment_financial_events_sanitize
  BEFORE INSERT OR UPDATE ON public.payment_financial_events
  FOR EACH ROW
  EXECUTE FUNCTION public.payment_financial_events_sanitize_detail();

-- Stage A: function defined but trigger NOT installed (Stage D installs when
-- payment_ssot_cutover.strict_trip_capture_mirror = true).
CREATE OR REPLACE FUNCTION public.trips_capture_amount_confirmed_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  confirmed integer;
  strict_on boolean := false;
BEGIN
  SELECT COALESCE(c.strict_trip_capture_mirror, false)
  INTO strict_on
  FROM public.payment_ssot_cutover c
  WHERE c.id = 1;

  IF NOT COALESCE(strict_on, false) THEN
    RETURN NEW;
  END IF;

  IF NEW.capture_amount_pence IS NOT DISTINCT FROM OLD.capture_amount_pence THEN
    RETURN NEW;
  END IF;
  IF NEW.capture_amount_pence IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT ps.capture_confirmed_pence
  INTO confirmed
  FROM public.payment_sessions ps
  WHERE ps.trip_id = NEW.id
    AND COALESCE(ps.capture_confirmed_pence, 0) > 0
    AND upper(COALESCE(ps.provider_state, '')) IN ('COMPLETED', 'CAPTURED')
  ORDER BY ps.captured_at DESC NULLS LAST, ps.updated_at DESC NULLS LAST
  LIMIT 1;

  IF confirmed IS NULL OR NEW.capture_amount_pence <> confirmed THEN
    RAISE EXCEPTION
      'trips.capture_amount_pence is legacy confirmed-only mirror; refused write % (confirmed %)',
      NEW.capture_amount_pence, confirmed
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- Trigger installed in Stage A but enforcement gated by cutover.strict flag (default off).
DROP TRIGGER IF EXISTS trg_trips_capture_amount_confirmed_only ON public.trips;
CREATE TRIGGER trg_trips_capture_amount_confirmed_only
  BEFORE UPDATE OF capture_amount_pence ON public.trips
  FOR EACH ROW
  EXECUTE FUNCTION public.trips_capture_amount_confirmed_only();

REVOKE ALL ON TABLE public.payment_payable_snapshots FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.payment_financial_operations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.payment_financial_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.payment_payable_snapshots TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.payment_financial_operations TO service_role;
GRANT SELECT, INSERT ON TABLE public.payment_financial_events TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.payment_financial_events_id_seq TO service_role;
