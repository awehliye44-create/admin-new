-- Allow Auth/customer (and driver) delete to SET NULL support_conversations FKs.
--
-- Root cause for phone 252625962724 / mohamud.devx@gmail.com:
-- customers CASCADE → support_conversations.customer_id SET NULL, but
-- valid_user_reference required customer_id IS NOT NULL for user_type=customer.
-- That aborted Auth delete with check_violation.
--
-- Detached threads keep history; participant id is cleared. Guest/WhatsApp rules
-- stay. Driver threads may also detach driver_id the same way.

BEGIN;

ALTER TABLE public.support_conversations
  DROP CONSTRAINT IF EXISTS valid_user_reference;

ALTER TABLE public.support_conversations
  ADD CONSTRAINT valid_user_reference CHECK (
    (
      user_type = 'customer'
      AND driver_id IS NULL
    )
    OR (
      user_type = 'guest'
      AND driver_id IS NULL
      AND channel = ANY (ARRAY['whatsapp'::text, 'website'::text, 'in_app'::text])
    )
    OR (
      user_type = 'driver'
      AND customer_id IS NULL
    )
  );

COMMENT ON CONSTRAINT valid_user_reference ON public.support_conversations IS
  'Customer/driver threads may have participant id SET NULL after Auth delete; guest channels stay guest-only.';

COMMIT;
