-- Rollback storage listing lock.
-- Recreates the exact pre-change SELECT policies.
-- Does not change bucket public flags or objects.

BEGIN;

CREATE POLICY "Anyone can read alert sounds"
  ON storage.objects
  FOR SELECT
  TO anon, authenticated
  USING (bucket_id = 'alert-sounds');

CREATE POLICY "Public read WhatsApp welcome assets"
  ON storage.objects
  FOR SELECT
  TO public
  USING (bucket_id = 'whatsapp-public');

COMMIT;
