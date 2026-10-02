-- Rollback for 20261208120000_payment_authorization_ledger_session_owner.sql.
--
-- Always: stop deriving ledger rows from payment_sessions.
-- Schema: restored to the pre-release shape ONLY while no session-owned row exists.
-- Once a row has trip_id NULL or payment_session_id set it is audit evidence; NOT NULL
-- cannot be restored without deleting it, so the columns, owner CHECK and indexes are
-- kept and a NOTICE is raised. Never deletes ledger rows.

DROP TRIGGER IF EXISTS trg_payment_session_ledger_sync ON public.payment_sessions;
DROP FUNCTION IF EXISTS public.tr_payment_session_ledger_sync();
DROP FUNCTION IF EXISTS public.payment_session_has_authorisation_evidence(text, timestamptz, text);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.payment_authorization_ledger
     WHERE trip_id IS NULL OR payment_session_id IS NOT NULL
  ) THEN
    RAISE NOTICE 'payment_authorization_ledger: session-owned rows exist; columns, owner CHECK and indexes retained';
    RETURN;
  END IF;
  DROP INDEX IF EXISTS public.payment_authorization_ledger_provider_order_idx;
  DROP INDEX IF EXISTS public.payment_authorization_ledger_session_initial_auth_uidx;
  ALTER TABLE public.payment_authorization_ledger DROP CONSTRAINT IF EXISTS payment_authorization_ledger_owner_chk;
  ALTER TABLE public.payment_authorization_ledger ALTER COLUMN trip_id SET NOT NULL;
  ALTER TABLE public.payment_authorization_ledger DROP COLUMN IF EXISTS provider_order_id;
  ALTER TABLE public.payment_authorization_ledger DROP COLUMN IF EXISTS payment_session_id;
  COMMENT ON COLUMN public.payment_authorization_ledger.trip_id IS NULL;
END $$;
