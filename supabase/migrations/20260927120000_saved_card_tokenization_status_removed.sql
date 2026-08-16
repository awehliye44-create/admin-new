-- Customer "Remove" on Payment Methods sets tokenization_status = 'removed'
-- (see delete-revolut-saved-card). Standalone setup may use 'active'.
-- Prior CHECK only allowed pending | verified | tokenization_failed, so Remove failed.

ALTER TABLE public.customer_saved_payment_method_tokens
  DROP CONSTRAINT IF EXISTS customer_saved_payment_method_tokens_status_chk;

ALTER TABLE public.customer_saved_payment_method_tokens
  ADD CONSTRAINT customer_saved_payment_method_tokens_status_chk
  CHECK (
    tokenization_status = ANY (
      ARRAY[
        'pending'::text,
        'active'::text,
        'verified'::text,
        'tokenization_failed'::text,
        'removed'::text
      ]
    )
  );
