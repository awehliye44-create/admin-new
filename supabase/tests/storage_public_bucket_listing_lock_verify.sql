-- Listing-policy simulation. Drops the two SELECT policies, probes, then ROLLBACK.
-- Does not change bucket public flags or object rows.

BEGIN;

DROP POLICY "Anyone can read alert sounds" ON storage.objects;
DROP POLICY "Public read WhatsApp welcome assets" ON storage.objects;

DO $$
DECLARE
  v_listing int;
  v_admin_write int;
  v_public_buckets int;
  v_alert_objects int;
  v_whatsapp_objects int;
BEGIN
  SELECT count(*) INTO v_listing
  FROM pg_policies
  WHERE schemaname = 'storage'
    AND tablename = 'objects'
    AND cmd = 'SELECT'
    AND (
      coalesce(qual, '') ILIKE '%alert-sounds%'
      OR coalesce(qual, '') ILIKE '%whatsapp-public%'
    );

  SELECT count(*) INTO v_admin_write
  FROM pg_policies
  WHERE schemaname = 'storage'
    AND tablename = 'objects'
    AND policyname IN (
      'Admins can upload alert sounds',
      'Admins can update alert sounds',
      'Admins can delete alert sounds'
    )
    AND roles = '{authenticated}'
    AND coalesce(qual, with_check, '') ILIKE '%has_role%'
    AND coalesce(qual, with_check, '') ILIKE '%admin%';

  SELECT count(*) INTO v_public_buckets
  FROM storage.buckets
  WHERE id IN ('alert-sounds', 'whatsapp-public')
    AND public IS TRUE;

  SELECT count(*) INTO v_alert_objects FROM storage.objects WHERE bucket_id = 'alert-sounds';
  SELECT count(*) INTO v_whatsapp_objects FROM storage.objects WHERE bucket_id = 'whatsapp-public';

  IF v_listing <> 0 OR v_admin_write <> 3 OR v_public_buckets <> 2
     OR v_alert_objects <> 10 OR v_whatsapp_objects <> 2 THEN
    RAISE EXCEPTION 'listing lock simulation failed listing=% admin_write=% public_buckets=% alert=% whatsapp=%',
      v_listing, v_admin_write, v_public_buckets, v_alert_objects, v_whatsapp_objects;
  END IF;
END $$;

SELECT
  (SELECT count(*) FROM pg_policies
   WHERE schemaname = 'storage' AND tablename = 'objects'
     AND policyname IN ('Anyone can read alert sounds', 'Public read WhatsApp welcome assets')) AS listing_policies,
  (SELECT count(*) FROM storage.buckets
   WHERE id IN ('alert-sounds', 'whatsapp-public') AND public IS TRUE) AS public_buckets,
  (SELECT count(*) FROM storage.objects WHERE bucket_id = 'alert-sounds') AS alert_objects,
  (SELECT count(*) FROM storage.objects WHERE bucket_id = 'whatsapp-public') AS whatsapp_objects;

ROLLBACK;
