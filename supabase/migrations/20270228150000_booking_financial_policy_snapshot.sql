-- #89 — Immutable booking financial policy snapshot + Admin preauth version audit.
-- Live Admin financial settings apply to NEW bookings only.
-- Existing bookings retain frozen buffer / policy on payment_sessions + trips.

ALTER TABLE public.payment_sessions
  ADD COLUMN IF NOT EXISTS booking_financial_policy_json jsonb;

ALTER TABLE public.trips
  ADD COLUMN IF NOT EXISTS booking_financial_policy_json jsonb;

COMMENT ON COLUMN public.payment_sessions.booking_financial_policy_json IS
  'Frozen booking financial contract (buffer, model, provider identity). Never secrets. Authoritative for lifecycle after booking create.';
COMMENT ON COLUMN public.trips.booking_financial_policy_json IS
  'Frozen booking financial contract mirrored from payment session at trip create. Never re-read live Admin settings.';

CREATE TABLE IF NOT EXISTS public.service_area_financial_policy_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_area_id uuid NOT NULL REFERENCES public.service_areas(id) ON DELETE CASCADE,
  policy_kind text NOT NULL DEFAULT 'preauth_buffer',
  version_number bigint NOT NULL,
  effective_at timestamptz NOT NULL DEFAULT now(),
  changed_by uuid NULL,
  change_source text NOT NULL DEFAULT 'admin_ui',
  previous_value jsonb,
  new_value jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_area_financial_policy_versions_kind_chk
    CHECK (policy_kind IN ('preauth_buffer', 'commission', 'waiting', 'airport', 'other'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_sa_financial_policy_versions_area_kind_n
  ON public.service_area_financial_policy_versions (service_area_id, policy_kind, version_number);

CREATE INDEX IF NOT EXISTS idx_sa_financial_policy_versions_area_effective
  ON public.service_area_financial_policy_versions (service_area_id, policy_kind, effective_at DESC);

ALTER TABLE public.service_area_financial_policy_versions ENABLE ROW LEVEL SECURITY;

-- Staff with payment config page access may read version history.
DROP POLICY IF EXISTS sa_financial_policy_versions_staff_select ON public.service_area_financial_policy_versions;
CREATE POLICY sa_financial_policy_versions_staff_select
  ON public.service_area_financial_policy_versions
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.staff_profiles sp
      WHERE sp.user_id = auth.uid()
        AND sp.is_active IS TRUE
    )
  );

-- Mutations only via SECURITY DEFINER trigger / service role.
REVOKE INSERT, UPDATE, DELETE ON public.service_area_financial_policy_versions FROM authenticated, anon;

CREATE OR REPLACE FUNCTION public.trg_service_area_preauth_settings_version()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_n bigint;
  v_prev jsonb;
  v_new jsonb;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.enable_preauth_buffer IS NOT DISTINCT FROM OLD.enable_preauth_buffer
     AND NEW.buffer_type IS NOT DISTINCT FROM OLD.buffer_type
     AND NEW.buffer_value IS NOT DISTINCT FROM OLD.buffer_value
     AND NEW.min_hold_pence IS NOT DISTINCT FROM OLD.min_hold_pence
     AND NEW.max_hold_pence IS NOT DISTINCT FROM OLD.max_hold_pence
  THEN
    RETURN NEW;
  END IF;

  v_prev := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) - 'id' - 'created_at' - 'updated_at' ELSE NULL END;
  v_new := to_jsonb(NEW) - 'id' - 'created_at' - 'updated_at';

  SELECT COALESCE(MAX(version_number), 0) + 1
    INTO v_n
  FROM public.service_area_financial_policy_versions
  WHERE service_area_id = NEW.service_area_id
    AND policy_kind = 'preauth_buffer';

  INSERT INTO public.service_area_financial_policy_versions (
    service_area_id, policy_kind, version_number, effective_at,
    changed_by, change_source, previous_value, new_value
  ) VALUES (
    NEW.service_area_id,
    'preauth_buffer',
    v_n,
    now(),
    auth.uid(),
    'admin_preauth_settings',
    v_prev,
    v_new
  );

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_service_area_preauth_settings_version ON public.service_area_preauth_settings;
CREATE TRIGGER trg_service_area_preauth_settings_version
  AFTER INSERT OR UPDATE ON public.service_area_preauth_settings
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_service_area_preauth_settings_version();

-- Seed current MK row as version 1 when no history exists (read-only baseline).
INSERT INTO public.service_area_financial_policy_versions (
  service_area_id, policy_kind, version_number, effective_at,
  change_source, previous_value, new_value
)
SELECT
  s.service_area_id,
  'preauth_buffer',
  1,
  COALESCE(s.updated_at, s.created_at, now()),
  'seed_current',
  NULL,
  jsonb_build_object(
    'enable_preauth_buffer', s.enable_preauth_buffer,
    'buffer_type', s.buffer_type,
    'buffer_value', s.buffer_value,
    'min_hold_pence', s.min_hold_pence,
    'max_hold_pence', s.max_hold_pence,
    'service_area_id', s.service_area_id
  )
FROM public.service_area_preauth_settings s
WHERE NOT EXISTS (
  SELECT 1 FROM public.service_area_financial_policy_versions v
  WHERE v.service_area_id = s.service_area_id AND v.policy_kind = 'preauth_buffer'
);

COMMENT ON TABLE public.service_area_financial_policy_versions IS
  'Append-only Admin financial policy history. Changes apply to new bookings only; existing bookings keep booking_financial_policy_json.';

-- Mirror frozen policy from payment session onto trip when trip is linked.
CREATE OR REPLACE FUNCTION public.trg_trips_mirror_booking_financial_policy()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_policy jsonb;
  v_buffer int;
BEGIN
  IF NEW.payment_session_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.booking_financial_policy_json IS NOT NULL
     AND NEW.preauth_buffer_pence IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT ps.booking_financial_policy_json, ps.buffer_pence
    INTO v_policy, v_buffer
  FROM public.payment_sessions ps
  WHERE ps.id = NEW.payment_session_id;

  IF NEW.booking_financial_policy_json IS NULL AND v_policy IS NOT NULL THEN
    NEW.booking_financial_policy_json := v_policy;
  END IF;
  IF NEW.preauth_buffer_pence IS NULL AND v_buffer IS NOT NULL THEN
    NEW.preauth_buffer_pence := v_buffer;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_trips_mirror_booking_financial_policy ON public.trips;
CREATE TRIGGER trg_trips_mirror_booking_financial_policy
  BEFORE INSERT OR UPDATE OF payment_session_id, booking_financial_policy_json, preauth_buffer_pence
  ON public.trips
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_trips_mirror_booking_financial_policy();
