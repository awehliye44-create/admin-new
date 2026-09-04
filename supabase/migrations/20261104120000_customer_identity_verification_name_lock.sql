-- Customer Veriff identity verification + name edit lock (per service-area mode).
-- Modes: off | optional | mandatory (default off).

-- ---------------------------------------------------------------------------
-- customers: verification + name lock columns
-- ---------------------------------------------------------------------------
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS identity_verified_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS identity_provider text NULL,
  ADD COLUMN IF NOT EXISTS name_edit_locked boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS name_unlocked_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS name_unlocked_by uuid NULL;

COMMENT ON COLUMN public.customers.identity_verified_at IS
  'Set only by signed Veriff decision webhook (or service_role). Never trust client.';
COMMENT ON COLUMN public.customers.name_edit_locked IS
  'When true, customer self-updates to first_name/last_name are rejected. Admin unlock clears lock only.';

-- ---------------------------------------------------------------------------
-- Per service-area customer identity settings
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.service_area_customer_identity_settings (
  service_area_id uuid PRIMARY KEY
    REFERENCES public.service_areas(id) ON DELETE CASCADE,
  mode text NOT NULL DEFAULT 'off'
    CHECK (mode IN ('off', 'optional', 'mandatory')),
  provider text NOT NULL DEFAULT 'veriff',
  provider_workflow_id text NULL,
  maximum_attempts integer NOT NULL DEFAULT 3
    CHECK (maximum_attempts >= 1 AND maximum_attempts <= 20),
  session_expiry_minutes integer NOT NULL DEFAULT 60
    CHECK (session_expiry_minutes >= 5 AND session_expiry_minutes <= 1440),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.tg_service_area_customer_identity_settings_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_service_area_customer_identity_settings_updated_at
  ON public.service_area_customer_identity_settings;
CREATE TRIGGER trg_service_area_customer_identity_settings_updated_at
  BEFORE UPDATE ON public.service_area_customer_identity_settings
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_service_area_customer_identity_settings_updated_at();

INSERT INTO public.service_area_customer_identity_settings (service_area_id, mode)
SELECT sa.id, 'off'
FROM public.service_areas sa
ON CONFLICT (service_area_id) DO NOTHING;

ALTER TABLE public.service_area_customer_identity_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins manage customer identity settings"
  ON public.service_area_customer_identity_settings;
CREATE POLICY "Admins manage customer identity settings"
  ON public.service_area_customer_identity_settings
  FOR ALL
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

DROP POLICY IF EXISTS "Service role manage customer identity settings"
  ON public.service_area_customer_identity_settings;
CREATE POLICY "Service role manage customer identity settings"
  ON public.service_area_customer_identity_settings
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Authenticated customers may read settings (gate / CTA) — no secrets.
DROP POLICY IF EXISTS "Customers read customer identity settings"
  ON public.service_area_customer_identity_settings;
CREATE POLICY "Customers read customer identity settings"
  ON public.service_area_customer_identity_settings
  FOR SELECT
  TO authenticated
  USING (true);

-- ---------------------------------------------------------------------------
-- customer_identity_verifications
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.customer_identity_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  service_area_id uuid NULL REFERENCES public.service_areas(id) ON DELETE SET NULL,
  provider text NOT NULL DEFAULT 'veriff',
  provider_session_id text NULL,
  provider_reference text NULL,
  status text NOT NULL DEFAULT 'started'
    CHECK (status IN (
      'started',
      'submitted',
      'processing',
      'approved',
      'declined',
      'resubmission_requested',
      'expired',
      'abandoned',
      'error'
    )),
  reason text NOT NULL DEFAULT 'customer_optional',
  attempt_count integer NOT NULL DEFAULT 1,
  max_attempts integer NULL,
  failure_code text NULL,
  face_match_result text NULL,
  liveness_result text NULL,
  image_quality_result text NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz NULL,
  submitted_at timestamptz NULL,
  decided_at timestamptz NULL,
  expires_at timestamptz NULL,
  device_id text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customer_identity_verifications_customer
  ON public.customer_identity_verifications (customer_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_identity_verifications_provider_session
  ON public.customer_identity_verifications (provider, provider_session_id)
  WHERE provider_session_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.tg_customer_identity_verifications_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_customer_identity_verifications_updated_at
  ON public.customer_identity_verifications;
CREATE TRIGGER trg_customer_identity_verifications_updated_at
  BEFORE UPDATE ON public.customer_identity_verifications
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_customer_identity_verifications_updated_at();

ALTER TABLE public.customer_identity_verifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Customers read own identity verifications"
  ON public.customer_identity_verifications;
CREATE POLICY "Customers read own identity verifications"
  ON public.customer_identity_verifications
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.customers c
      WHERE c.id = customer_identity_verifications.customer_id
        AND c.user_id = auth.uid()
        AND c.deleted_at IS NULL
    )
  );

DROP POLICY IF EXISTS "Admins read customer identity verifications"
  ON public.customer_identity_verifications;
CREATE POLICY "Admins read customer identity verifications"
  ON public.customer_identity_verifications
  FOR SELECT
  USING (has_role(auth.uid(), 'admin'::app_role));

DROP POLICY IF EXISTS "Service role manage customer identity verifications"
  ON public.customer_identity_verifications;
CREATE POLICY "Service role manage customer identity verifications"
  ON public.customer_identity_verifications
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ---------------------------------------------------------------------------
-- Webhook audit (service_role only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.customer_identity_provider_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL DEFAULT 'veriff',
  provider_event_id text NULL,
  verification_id uuid NULL
    REFERENCES public.customer_identity_verifications(id) ON DELETE SET NULL,
  event_type text NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  signature_valid boolean NOT NULL DEFAULT false,
  processed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customer_identity_webhook_events_created
  ON public.customer_identity_provider_webhook_events (created_at DESC);

ALTER TABLE public.customer_identity_provider_webhook_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role manage customer identity webhooks"
  ON public.customer_identity_provider_webhook_events;
CREATE POLICY "Service role manage customer identity webhooks"
  ON public.customer_identity_provider_webhook_events
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS "Admins read customer identity webhooks"
  ON public.customer_identity_provider_webhook_events;
CREATE POLICY "Admins read customer identity webhooks"
  ON public.customer_identity_provider_webhook_events
  FOR SELECT
  USING (has_role(auth.uid(), 'admin'::app_role));

-- ---------------------------------------------------------------------------
-- Name lock trigger — reject customer self-updates when locked
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tg_customers_enforce_name_edit_lock()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF COALESCE(OLD.name_edit_locked, false) = true
     AND (
       NEW.first_name IS DISTINCT FROM OLD.first_name
       OR NEW.last_name IS DISTINCT FROM OLD.last_name
     )
  THEN
    RAISE EXCEPTION 'CUSTOMER_NAME_EDIT_LOCKED'
      USING ERRCODE = 'P0001',
            DETAIL = 'Name edits are locked after identity verification. Admin unlock required.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_customers_enforce_name_edit_lock ON public.customers;
CREATE TRIGGER trg_customers_enforce_name_edit_lock
  BEFORE UPDATE ON public.customers
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_customers_enforce_name_edit_lock();

-- ---------------------------------------------------------------------------
-- Admin unlock name edits (does not clear identity_verified_at)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_unlock_customer_name_edit(p_customer_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.customers%ROWTYPE;
BEGIN
  IF v_uid IS NULL OR NOT public.has_role(v_uid, 'admin'::app_role) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  UPDATE public.customers
  SET
    name_edit_locked = false,
    name_unlocked_at = now(),
    name_unlocked_by = v_uid,
    updated_at = now()
  WHERE id = p_customer_id
    AND deleted_at IS NULL
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'customer_id', v_row.id,
    'name_edit_locked', v_row.name_edit_locked,
    'identity_verified_at', v_row.identity_verified_at,
    'name_unlocked_at', v_row.name_unlocked_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_unlock_customer_name_edit(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_unlock_customer_name_edit(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_unlock_customer_name_edit(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- Customer gate helper
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_customer_identity_verification_gate(
  p_service_area_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_customer public.customers%ROWTYPE;
  v_settings public.service_area_customer_identity_settings%ROWTYPE;
  v_sa uuid := p_service_area_id;
  v_mode text := 'off';
  v_verified boolean := false;
  v_locked boolean := false;
  v_can_start boolean := false;
  v_block_book boolean := false;
  v_offer_cta boolean := false;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'UNAUTHENTICATED',
      'mode', 'off',
      'verified', false,
      'name_edit_locked', false,
      'can_start', false,
      'block_book', false,
      'offer_cta', false,
      'service_area_id', null
    );
  END IF;

  SELECT * INTO v_customer
  FROM public.customers
  WHERE user_id = v_uid AND deleted_at IS NULL
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'NO_PROFILE',
      'mode', 'off',
      'verified', false,
      'name_edit_locked', false,
      'can_start', false,
      'block_book', false,
      'offer_cta', false,
      'service_area_id', null
    );
  END IF;

  v_verified := v_customer.identity_verified_at IS NOT NULL;
  v_locked := COALESCE(v_customer.name_edit_locked, false);

  -- Resolve SA: explicit arg, else last trip SA.
  IF v_sa IS NULL THEN
    SELECT t.service_area_id INTO v_sa
    FROM public.trips t
    WHERE t.passenger_id = v_customer.id
      AND t.service_area_id IS NOT NULL
    ORDER BY t.created_at DESC
    LIMIT 1;
  END IF;

  IF v_sa IS NOT NULL THEN
    SELECT * INTO v_settings
    FROM public.service_area_customer_identity_settings
    WHERE service_area_id = v_sa;

    IF FOUND THEN
      v_mode := COALESCE(v_settings.mode, 'off');
    END IF;
  END IF;

  -- If no SA resolved, offer CTA when any SA is optional/mandatory (Account promo).
  IF v_sa IS NULL AND NOT v_verified THEN
    IF EXISTS (
      SELECT 1 FROM public.service_area_customer_identity_settings s
      WHERE s.mode IN ('optional', 'mandatory')
    ) THEN
      v_mode := 'optional';
      v_offer_cta := true;
    END IF;
  END IF;

  IF v_mode IN ('optional', 'mandatory') AND NOT v_verified THEN
    v_offer_cta := true;
    v_can_start := true;
  END IF;

  IF v_mode = 'mandatory' AND NOT v_verified THEN
    v_block_book := true;
  END IF;

  IF v_verified THEN
    v_can_start := false;
    v_block_book := false;
    v_offer_cta := false;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'code', 'OK',
    'mode', v_mode,
    'verified', v_verified,
    'name_edit_locked', v_locked,
    'can_start', v_can_start,
    'block_book', v_block_book,
    'offer_cta', v_offer_cta,
    'service_area_id', v_sa,
    'identity_verified_at', v_customer.identity_verified_at,
    'customer_id', v_customer.id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_customer_identity_verification_gate(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_customer_identity_verification_gate(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_customer_identity_verification_gate(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- Refresh admin riders view with identity columns
-- (DROP + CREATE required — CREATE OR REPLACE cannot reshape view columns)
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS public.admin_riders_with_trip_stats;

CREATE VIEW public.admin_riders_with_trip_stats AS
SELECT
  c.id,
  c.user_id,
  c.customer_code,
  c.first_name,
  c.last_name,
  c.phone,
  public.admin_get_user_email(c.user_id) AS email,
  c.created_at,
  c.updated_at,
  c.rider_status,
  c.email_verified,
  c.phone_verified,
  c.identity_verified_at,
  c.identity_provider,
  c.name_edit_locked,
  c.name_unlocked_at,
  COALESCE(ts.trip_count, 0) AS trip_count,
  ts.last_trip_at
FROM public.customers c
LEFT JOIN (
  SELECT
    t.passenger_id,
    count(*)::integer AS trip_count,
    max(t.created_at) AS last_trip_at
  FROM public.trips t
  WHERE t.passenger_id IS NOT NULL
  GROUP BY t.passenger_id
) ts ON ts.passenger_id = c.id
WHERE c.deleted_at IS NULL;

GRANT SELECT ON public.admin_riders_with_trip_stats TO authenticated;
