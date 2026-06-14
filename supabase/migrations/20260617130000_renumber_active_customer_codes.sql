-- Renumber active customers to contiguous CU001..CU00N codes.
-- Prior test signups (hard-deleted) left the global sequence at 23 while only 3
-- active customers remain. Trips/bookings use customers.id (UUID), not customer_code.

BEGIN;

-- Avoid UNIQUE(customer_code) collisions during reassignment.
UPDATE public.customers
SET customer_code = 'TMP-' || id::text
WHERE deleted_at IS NULL;

WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (ORDER BY created_at ASC, id ASC) AS rn
  FROM public.customers
  WHERE deleted_at IS NULL
)
UPDATE public.customers AS c
SET
  customer_code = 'CU' || LPAD(r.rn::text, 3, '0'),
  updated_at = now()
FROM ranked AS r
WHERE c.id = r.id;

INSERT INTO public.global_sequences (sequence_type, current_value)
SELECT
  'customer',
  COUNT(*)::integer
FROM public.customers
WHERE deleted_at IS NULL
ON CONFLICT (sequence_type)
DO UPDATE SET
  current_value = EXCLUDED.current_value,
  updated_at = now();

COMMIT;
