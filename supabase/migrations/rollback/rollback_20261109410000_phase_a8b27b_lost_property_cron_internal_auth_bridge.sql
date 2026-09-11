-- Rollback: Phase A8B27B lost-property cron internal auth bridge
-- WARNING: Restores pre-bridge cron command shapes that used Authorization Bearer
-- (anon gateway). Only run AFTER Edge is rolled back to v267 (or otherwise still
-- accepts unauthenticated cron). Prefer Edge rollback first.
-- Does NOT delete Vault/Edge secrets.
-- Does NOT re-open helper EXECUTE to anon/authenticated/service_role after drop.

BEGIN;

-- Restore schedules/commands to the pre-A8B27B shape WITHOUT embedding a live token.
-- Commands call a temporary restore note: operators must re-seed Authorization if
-- rolling all the way back before Edge gate removal. Safer default: keep helper
-- headers if Edge gate remains.

-- If rolling back fully to unauthenticated Edge v267, replace headers with
-- Content-Type only is unsafe; historical shape used Authorization Bearer anon.
-- We restore helper-based headers removal by switching back only when explicitly
-- using Content-Type alone is unacceptable — instead keep helper if present,
-- else fall back to Content-Type-only POST (Edge v267 ignores auth anyway).

SELECT cron.alter_job(
  7,
  command := $cmd$
  SELECT net.http_post(
    url := 'https://thazislrdkjpvvghtvzo.supabase.co/functions/v1/lost-property?action=cleanup_photos',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  ) AS request_id;
  $cmd$
);

SELECT cron.alter_job(
  8,
  command := $cmd$
  SELECT net.http_post(
    url := 'https://thazislrdkjpvvghtvzo.supabase.co/functions/v1/lost-property?action=expire_chats',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  ) AS request_id;
  $cmd$
);

DROP FUNCTION IF EXISTS public.onecab_internal_lost_property_cron_http_headers();

COMMIT;
