-- #93A / #103 — Authorisation projection semantics at the database boundary.
--
-- authorised_amount_pence / original_authorised_pence = original preauth hold (immutable once set).
-- total_authorised_amount_pence = local mirror of confirmed cumulative coverage (never regress).
-- Provider retrieve remains decision authority for coverage; this guard prevents writer contamination.
--
-- Does NOT rewrite historical authorised_promoted rows (P4). Compatible with contaminated values:
-- further mutation of original hold is blocked; total may still advance monotonically.

COMMENT ON COLUMN public.payment_sessions.authorised_amount_pence IS
  'Original preauth hold (booking). Immutable after first positive value. NOT live coverage after increments — use total_authorised_amount_pence / provider retrieve.';

COMMENT ON COLUMN public.payment_sessions.original_authorised_pence IS
  'Explicit original authorised hold twin of authorised_amount_pence. Immutable after first positive value.';

COMMENT ON COLUMN public.payment_sessions.total_authorised_amount_pence IS
  'Local mirror of confirmed cumulative authorised TOTAL after increments. Prefer provider retrieve for decisions. Must not regress.';

COMMENT ON COLUMN public.payment_sessions.additional_authorised_pence IS
  'Cumulative additional authorised beyond original hold (resolution metadata).';

CREATE OR REPLACE FUNCTION public.payment_sessions_authorisation_projection_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  -- Original hold: once positive, refuse mutation (preserve OLD — catch app bugs without stranding rows).
  IF OLD.authorised_amount_pence IS NOT NULL
     AND COALESCE(OLD.authorised_amount_pence, 0) > 0
     AND NEW.authorised_amount_pence IS DISTINCT FROM OLD.authorised_amount_pence THEN
    NEW.authorised_amount_pence := OLD.authorised_amount_pence;
  END IF;

  IF OLD.original_authorised_pence IS NOT NULL
     AND COALESCE(OLD.original_authorised_pence, 0) > 0
     AND NEW.original_authorised_pence IS DISTINCT FROM OLD.original_authorised_pence THEN
    NEW.original_authorised_pence := OLD.original_authorised_pence;
  END IF;

  -- Confirmed coverage mirror: never regress a positive total.
  IF OLD.total_authorised_amount_pence IS NOT NULL
     AND COALESCE(OLD.total_authorised_amount_pence, 0) > 0
     AND NEW.total_authorised_amount_pence IS NOT NULL
     AND COALESCE(NEW.total_authorised_amount_pence, 0) < OLD.total_authorised_amount_pence THEN
    NEW.total_authorised_amount_pence := OLD.total_authorised_amount_pence;
  END IF;

  -- When total advances and original is still unset, do not invent original from NEW total here
  -- (application seeds original only on first AUTHORISED). Leave NULL/0 alone.

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_payment_sessions_authorisation_projection_guard
  ON public.payment_sessions;

CREATE TRIGGER trg_payment_sessions_authorisation_projection_guard
  BEFORE UPDATE ON public.payment_sessions
  FOR EACH ROW
  EXECUTE FUNCTION public.payment_sessions_authorisation_projection_guard();

REVOKE ALL ON FUNCTION public.payment_sessions_authorisation_projection_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payment_sessions_authorisation_projection_guard() FROM anon, authenticated;
