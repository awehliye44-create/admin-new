-- A driver booking as a passenger needs a customers row on their own auth user.
-- The insert trigger treated every driver phone as foreign, including that
-- same user. A different user still cannot take the phone.

CREATE OR REPLACE FUNCTION public.enforce_customer_identity_uniqueness()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_phone text := nullif(trim(new.phone), '');
BEGIN
  IF new.deleted_at IS NOT NULL THEN
    RETURN new;
  END IF;

  IF v_phone IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM public.drivers d
      WHERE d.phone = v_phone
        AND d.deleted_at IS NULL
        AND d.user_id IS DISTINCT FROM new.user_id
    ) THEN
      RAISE EXCEPTION 'phone_already_in_use'
        USING errcode = '23505',
              hint = 'This phone number is already linked to a driver account.';
    END IF;
  END IF;

  RETURN new;
END;
$function$;
