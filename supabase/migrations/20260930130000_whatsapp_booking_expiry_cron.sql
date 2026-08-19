-- pg_cron job: sweep expired WhatsApp booking sessions every 1 minute.
-- Uses pg_net.http_post to call the whatsapp-session-expire Edge Function.
-- Follows the same pattern as existing cron jobs (hardcoded project URL;
-- service-role key from vault.decrypted_secrets).

SELECT cron.schedule(
  'whatsapp-booking-session-expiry',
  '* * * * *',
  $$
  SELECT net.http_post(
    url     := 'https://thazislrdkjpvvghtvzo.supabase.co/functions/v1/whatsapp-session-expire',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key' LIMIT 1)
    ),
    body    := '{}'::jsonb
  );
  $$
);
