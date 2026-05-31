
-- Prevent duplicate merchant applications by email or business name (case-insensitive)
CREATE UNIQUE INDEX IF NOT EXISTS merchants_email_unique_ci
  ON public.merchants (lower(email))
  WHERE email IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS merchants_business_name_unique_ci
  ON public.merchants (lower(business_name));
