-- P7 M4: WhatsApp durable replay without waiting for Meta redelivery.
--
-- Every 2 minutes pg_cron calls Edge `whatsapp-inbound-retry-sweep` (net.http_post, Bearer from
-- vault `service_role_key` — same pattern as sweep-pending-trip-invoices-every-5min). The Edge
-- function replays unprocessed whatsapp_inbound_messages rows older than 2 minutes with
-- attempt_count < 3 via claim_whatsapp_inbound_retry + processWhatsAppInboundMessage, and records
-- a durable WHATSAPP_INBOUND_RETRY_EXHAUSTED alert (payment_financial_events) on exhaustion.
--
-- Idempotent: an existing job (by jobname) is never duplicated and its command is never
-- rewritten; only a drifted schedule is corrected. Apply AFTER the Edge function is deployed.

-- Supports the sweep's candidate scan (unprocessed, retryable).
CREATE INDEX IF NOT EXISTS whatsapp_inbound_messages_retry_sweep_idx
  ON public.whatsapp_inbound_messages (received_at)
  WHERE processed_at IS NULL AND attempt_count < 3;

DO $$
DECLARE
  v_job_name text := 'whatsapp-inbound-retry-sweep';
  v_job_id bigint;
  v_schedule text;
BEGIN
  IF to_regnamespace('cron') IS NULL THEN
    RAISE NOTICE 'pg_cron not installed; skipping P7 M4 whatsapp-inbound-retry-sweep job.';
    RETURN;
  END IF;

  SELECT jobid, schedule INTO v_job_id, v_schedule
  FROM cron.job WHERE jobname = 'whatsapp-inbound-retry-sweep' LIMIT 1;

  IF FOUND THEN
    IF v_schedule IS DISTINCT FROM '*/2 * * * *' THEN
      PERFORM cron.alter_job(v_job_id, schedule := '*/2 * * * *');
    END IF;
    RETURN;
  END IF;

  PERFORM cron.schedule(
    v_job_name,
    '*/2 * * * *',
    $cron_cmd$
    SELECT net.http_post(
      url := 'https://thazislrdkjpvvghtvzo.supabase.co/functions/v1/whatsapp-inbound-retry-sweep',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (
          SELECT decrypted_secret FROM vault.decrypted_secrets
          WHERE name = 'service_role_key' LIMIT 1
        )
      ),
      body := '{"source":"pg_cron","limit":20}'::jsonb,
      timeout_milliseconds := 55000
    );
    $cron_cmd$
  );
END;
$$;
