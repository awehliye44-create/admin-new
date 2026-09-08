-- ============================================================
-- Storage listing lock for public buckets.
-- Drops only the two broad SELECT policies that make
-- alert-sounds and whatsapp-public enumerable.
-- Buckets stay public so known-object URLs keep working.
-- Admin alert-sound write policies are not changed.
-- ============================================================

BEGIN;

DROP POLICY "Anyone can read alert sounds" ON storage.objects;
DROP POLICY "Public read WhatsApp welcome assets" ON storage.objects;

COMMIT;
