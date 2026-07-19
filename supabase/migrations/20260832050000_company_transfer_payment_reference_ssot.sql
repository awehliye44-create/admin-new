-- P0: Company transfer payment reference SSOT (admin-new mirror)
-- Backend-allocated immutable refs: ONECAB-CT-YYMMDD-000001 / ONECAB-CERT-YYMMDD-000001

ALTER TABLE public.company_outgoing_transfers
  ADD COLUMN IF NOT EXISTS statement_reference text;

COMMENT ON COLUMN public.company_outgoing_transfers.payment_reference IS
  'Immutable SSOT payment reference (ONECAB-CT|CERT-YYMMDD-######). Backend-generated at create. Never invented by admin.';

COMMENT ON COLUMN public.company_outgoing_transfers.statement_reference IS
  'Optional custom statement label for internal ops. Does not replace payment_reference. Never sent as a substitute for the SSOT ref.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_company_outgoing_transfers_payment_reference
  ON public.company_outgoing_transfers (payment_reference)
  WHERE payment_reference IS NOT NULL AND btrim(payment_reference) <> '';

CREATE TABLE IF NOT EXISTS public.company_transfer_payment_reference_counters (
  ref_day date NOT NULL,
  kind text NOT NULL CHECK (kind IN ('CT', 'CERT')),
  last_seq integer NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ref_day, kind)
);

COMMENT ON TABLE public.company_transfer_payment_reference_counters IS
  'Daily sequential counters for company transfer payment references (Europe/London calendar day).';

CREATE OR REPLACE FUNCTION public.allocate_company_transfer_payment_reference(
  p_kind text DEFAULT 'CT',
  p_at timestamptz DEFAULT now()
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_kind text;
  v_day date;
  v_seq integer;
  v_yymmdd text;
  v_ref text;
BEGIN
  v_kind := upper(trim(COALESCE(p_kind, 'CT')));
  IF v_kind NOT IN ('CT', 'CERT') THEN
    v_kind := 'CT';
  END IF;

  v_day := (COALESCE(p_at, now()) AT TIME ZONE 'Europe/London')::date;
  v_yymmdd := to_char(v_day, 'YYMMDD');

  INSERT INTO public.company_transfer_payment_reference_counters AS c (ref_day, kind, last_seq, updated_at)
  VALUES (v_day, v_kind, 1, now())
  ON CONFLICT (ref_day, kind)
  DO UPDATE SET
    last_seq = c.last_seq + 1,
    updated_at = now()
  RETURNING last_seq INTO v_seq;

  v_ref := 'ONECAB-' || v_kind || '-' || v_yymmdd || '-' || lpad(v_seq::text, 6, '0');

  IF char_length(v_ref) > 40 THEN
    RAISE EXCEPTION 'COMPANY_TRANSFER_PAYMENT_REFERENCE_TOO_LONG';
  END IF;

  RETURN v_ref;
END;
$$;

REVOKE ALL ON FUNCTION public.allocate_company_transfer_payment_reference(text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.allocate_company_transfer_payment_reference(text, timestamptz) TO service_role;

COMMENT ON FUNCTION public.allocate_company_transfer_payment_reference(text, timestamptz) IS
  'Atomically allocates the next ONECAB-CT|CERT-YYMMDD-###### payment reference for company transfers.';
