-- Driver statement PDF/delivery writes invoice_pdf_error on public.invoices.
-- The column existed only on trips, so generate/deliver updates failed and portal
-- invoices stayed empty (drafts without pdf_storage_path; send marked status only).
-- Also schedule auto-generate-statements hourly; next_run_at remains the gate.

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS invoice_pdf_error text;

COMMENT ON COLUMN public.invoices.invoice_pdf_error IS
  'Last driver-statement PDF generation/delivery error; cleared on success.';

DO $$
DECLARE
  v_job_name TEXT := 'auto-generate-statements-hourly';
  v_existing BIGINT;
BEGIN
  SELECT jobid INTO v_existing
  FROM cron.job
  WHERE jobname = v_job_name
  LIMIT 1;

  IF FOUND THEN
    RAISE NOTICE 'pg_cron job % already exists (jobid=%), skipping creation.', v_job_name, v_existing;
    RETURN;
  END IF;

  PERFORM cron.schedule(
    v_job_name,
    '5 * * * *',
    $cron_cmd$
    SELECT net.http_post(
      url := 'https://thazislrdkjpvvghtvzo.supabase.co/functions/v1/auto-generate-statements',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (
          SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key' LIMIT 1
        )
      ),
      body := '{"source":"pg_cron"}'::jsonb,
      timeout_milliseconds := 120000
    );
    $cron_cmd$
  );

  RAISE NOTICE 'pg_cron job % created successfully.', v_job_name;
END;
$$;
