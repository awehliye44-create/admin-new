-- Customer account deletion: minimise and detach the profile instead of
-- hard-deleting it, matching the driver path.
--
-- Hard-deleting a customer cascades customer_wallets / customer_wallet_ledger,
-- customer_identity_verifications and rider_feedback, and is blocked outright by
-- booking_payment_quotes / customer_receivables. Those are accounting, payment,
-- fraud-prevention and safety records that must be retained.
--
-- After this function runs the row is anonymised, marked deleted and no longer
-- linked to an Auth user, so admin-delete-account can delete the Auth user
-- (revoking every session) without the customers_user_id_fkey cascade touching
-- the row. The person can then sign up again with the same phone/email.

ALTER TABLE public.customers ALTER COLUMN user_id DROP NOT NULL;

CREATE OR REPLACE FUNCTION public.admin_minimise_deleted_customer(p_customer_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid;
BEGIN
  IF p_customer_id IS NULL THEN
    RAISE EXCEPTION 'p_customer_id is required';
  END IF;

  SELECT c.user_id INTO v_user_id
  FROM public.customers c
  WHERE c.id = p_customer_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'customer_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- Clearing the phone is a sanctioned server-side change, not a user edit.
  PERFORM set_config('onecab.phone_change_apply', '1', true);
  PERFORM set_config('app.bypass_customer_name_lock', '1', true);

  -- fn_rider_status_enforce still refuses while the customer has an active trip.
  UPDATE public.customers
  SET rider_status = 'deleted',
      deleted_at = COALESCE(deleted_at, now()),
      user_id = NULL,
      first_name = 'Deleted',
      last_name = 'Customer',
      phone = NULL,
      pending_phone_change = NULL,
      pending_phone_change_requested_at = NULL,
      pending_phone_change_verified_at = NULL,
      pending_phone_change_expires_at = NULL,
      pending_phone_change_otp_sent_at = NULL,
      pending_email_change = NULL,
      pending_email_change_requested_at = NULL,
      pending_email_change_verified_at = NULL,
      pending_email_change_expires_at = NULL
  WHERE id = p_customer_id;

  RETURN v_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_minimise_deleted_customer(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_minimise_deleted_customer(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_minimise_deleted_customer(uuid) TO service_role;

COMMENT ON FUNCTION public.admin_minimise_deleted_customer(uuid) IS
  'Service role only. Anonymises a customer, marks it deleted and detaches it from Auth; returns the previous user_id. Retains trip, payment, wallet, verification and safety records.';
