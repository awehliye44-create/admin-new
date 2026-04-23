
-- 1. Replace handle_new_customer with role-gated, name-safe version
CREATE OR REPLACE FUNCTION public.handle_new_customer()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_app_type TEXT;
BEGIN
  v_app_type := COALESCE(NEW.raw_user_meta_data ->> 'app_type', 'customer');

  IF v_app_type <> 'customer' THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.customers (user_id, first_name, last_name, phone)
  VALUES (
    NEW.id,
    COALESCE(NULLIF(TRIM(NEW.raw_user_meta_data ->> 'first_name'), ''), 'Customer'),
    COALESCE(NULLIF(TRIM(NEW.raw_user_meta_data ->> 'last_name'), ''), ''),
    NEW.raw_user_meta_data ->> 'phone'
  )
  ON CONFLICT (user_id) DO NOTHING;

  RETURN NEW;
END;
$function$;

-- 2. Remove redundant duplicate UNIQUE constraint on customers.user_id
ALTER TABLE public.customers DROP CONSTRAINT IF EXISTS customers_user_id_unique;

-- 3. Clean up duplicate / overlapping RLS policies on customers
DROP POLICY IF EXISTS "Users can read own profile" ON public.customers;
DROP POLICY IF EXISTS "Users can update own profile" ON public.customers;
DROP POLICY IF EXISTS "Users can update their own customer record" ON public.customers;
DROP POLICY IF EXISTS "Users can view their own customer record" ON public.customers;
DROP POLICY IF EXISTS "Admins can read all customers" ON public.customers;
DROP POLICY IF EXISTS "Admins can update customers" ON public.customers;
DROP POLICY IF EXISTS "Admins can delete customers" ON public.customers;

DROP POLICY IF EXISTS "Users can create own customer record" ON public.customers;
CREATE POLICY "Users can create own customer record"
ON public.customers
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = user_id);

-- 4. Clean up duplicate driver INSERT and SELECT policies
DROP POLICY IF EXISTS "Users can create their own driver profile" ON public.drivers;
DROP POLICY IF EXISTS "Drivers can view own profile" ON public.drivers;

-- 5. Allow service role full management of drivers (needed for admin-delete-account edge fn)
DROP POLICY IF EXISTS "Service role can manage drivers" ON public.drivers;
CREATE POLICY "Service role can manage drivers"
ON public.drivers
FOR ALL
TO public
USING (auth.role() = 'service_role')
WITH CHECK (auth.role() = 'service_role');

-- 6. Allow admins to DELETE drivers
DROP POLICY IF EXISTS "Admins can delete drivers" ON public.drivers;
CREATE POLICY "Admins can delete drivers"
ON public.drivers
FOR DELETE
TO authenticated
USING (has_role(auth.uid(), 'admin'::app_role));
