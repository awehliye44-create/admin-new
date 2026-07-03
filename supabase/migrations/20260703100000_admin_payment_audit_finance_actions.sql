-- Extend admin payment audit actions for finance notes and Stripe sync.
ALTER TABLE public.admin_payment_audit DROP CONSTRAINT IF EXISTS admin_payment_audit_action_check;
ALTER TABLE public.admin_payment_audit ADD CONSTRAINT admin_payment_audit_action_check
  CHECK (action = ANY (ARRAY[
    'capture'::text,
    'refund'::text,
    'edit_fare'::text,
    'cancel'::text,
    'extra_payment'::text,
    'finance_note'::text,
    'sync_stripe'::text
  ]));
