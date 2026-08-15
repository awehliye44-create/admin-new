-- Admin batch read of Driver Wallet Ledger pending/available (eligibility SSOT).
-- Does not call a provider API and does not create a second wallet.

BEGIN;

CREATE OR REPLACE FUNCTION public.admin_driver_wallet_eligibility_balances(p_driver_ids uuid[])
RETURNS TABLE (
  driver_id uuid,
  live_balance_pence bigint,
  available_balance_pence bigint,
  pending_balance_pence bigint,
  withdrawal_in_progress_pence bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  IF NOT (
    public.is_admin()
    OR public.has_role(v_uid, 'admin'::public.app_role)
    OR EXISTS (
      SELECT 1
      FROM public.staff_profiles sp
      WHERE sp.user_id = v_uid
        AND sp.is_active
    )
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  RETURN QUERY
  SELECT
    d.id,
    b.live_balance_pence,
    b.available_balance_pence,
    b.pending_balance_pence,
    b.withdrawal_in_progress_pence
  FROM unnest(COALESCE(p_driver_ids, ARRAY[]::uuid[])) AS d(id)
  CROSS JOIN LATERAL public.driver_wallet_eligibility_balances(d.id) b;
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_driver_wallet_eligibility_balances(uuid[]) TO authenticated, service_role;

COMMIT;
