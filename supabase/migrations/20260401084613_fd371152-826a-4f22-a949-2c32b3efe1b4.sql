
-- Fix 1: Make the lost-property-photos bucket private
UPDATE storage.buckets SET public = false WHERE id = 'lost-property-photos';

-- Drop any existing overly permissive policies
DROP POLICY IF EXISTS "Lost property photos are publicly accessible" ON storage.objects;

-- Authenticated users can read photos for their cases (customer or driver)
CREATE POLICY "LP photos viewable by case participants"
ON storage.objects FOR SELECT
TO authenticated
USING (
  bucket_id = 'lost-property-photos'
  AND EXISTS (
    SELECT 1 FROM public.lost_property_cases lpc
    WHERE (lpc.customer_id = auth.uid() OR lpc.driver_id = auth.uid())
      AND lpc.photos_hidden_at IS NULL
      AND (
        lpc.photos::text LIKE '%' || storage.objects.name || '%'
        OR lpc.found_item_photos::text LIKE '%' || storage.objects.name || '%'
      )
  )
);

-- Users can upload photos to their own folder
CREATE POLICY "LP users can upload photos"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'lost-property-photos'
  AND (storage.foldername(name))[1] = auth.uid()::text
);

-- Fix 2: Function to expire chats and insert system messages
CREATE OR REPLACE FUNCTION public.lost_property_expire_chats()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  expired_count integer := 0;
  expired_case record;
BEGIN
  FOR expired_case IN
    SELECT id FROM lost_property_cases
    WHERE chat_enabled = true
      AND status != 'CLOSED'
      AND chat_expires_at < now()
  LOOP
    UPDATE lost_property_cases
    SET chat_enabled = false,
        chat_locked_at = now(),
        chat_lock_reason = 'CHAT_EXPIRED',
        updated_at = now()
    WHERE id = expired_case.id;

    INSERT INTO lost_property_messages (case_id, sender_type, message)
    VALUES (expired_case.id, 'SYSTEM', 'Chat has expired. Messages are now read-only.');

    expired_count := expired_count + 1;
  END LOOP;

  RETURN expired_count;
END;
$$;
