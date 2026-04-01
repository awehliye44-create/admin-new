
-- Issue 1: Remove legacy permissive storage SELECT policy
DROP POLICY IF EXISTS "Anyone can view lost property photos" ON storage.objects;

-- Issue 2: Remove duplicate upload policy (keep "LP users can upload photos")
DROP POLICY IF EXISTS "Users can upload lost property photos" ON storage.objects;

-- Issue 3: Fix return_method CHECK constraint to accept uppercase values from edge function
ALTER TABLE public.lost_property_cases DROP CONSTRAINT IF EXISTS lost_property_cases_return_method_check;
ALTER TABLE public.lost_property_cases ADD CONSTRAINT lost_property_cases_return_method_check
  CHECK (return_method IS NULL OR return_method = ANY(ARRAY['COLLECT','BOOK_RIDE','SHIP','collect','book_ride','ship']));
