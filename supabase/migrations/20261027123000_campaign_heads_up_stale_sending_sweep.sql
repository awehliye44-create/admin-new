-- Also wake the due-sweep when a campaign is stuck in status=sending
-- (worker crash / missed heartbeat) so claimCampaign can reclaim it.

CREATE OR REPLACE FUNCTION public.campaign_heads_up_due_sweep()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_url text := coalesce(
    nullif(trim(current_setting('app.settings.edge_send_campaign_heads_up_url', true)), ''),
    'https://thazislrdkjpvvghtvzo.supabase.co/functions/v1/send-campaign-heads-up'
  );
  v_token text := public.cron_edge_auth_token();
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.campaign_heads_up_campaigns c
    WHERE (
      c.status = 'scheduled'
      AND (
        c.ends_at IS NOT NULL AND c.ends_at <= now()
        OR coalesce(c.scheduled_at, c.starts_at) IS NOT NULL
           AND coalesce(c.scheduled_at, c.starts_at) <= now()
      )
    )
    OR (
      c.status = 'sending'
      AND c.updated_at <= now() - interval '15 minutes'
    )
    LIMIT 1
  ) THEN
    RETURN;
  END IF;

  IF v_url IS NULL OR length(trim(v_url)) < 20 THEN
    RAISE LOG '[campaign-heads-up] sweep aborted reason=bad_url';
    RETURN;
  END IF;

  IF v_token IS NULL OR length(trim(v_token)) < 20 THEN
    RAISE LOG '[campaign-heads-up] sweep aborted reason=bad_token';
    RETURN;
  END IF;

  BEGIN
    PERFORM net.http_post(
      url := v_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_token,
        'apikey', v_token
      ),
      body := jsonb_build_object('source', 'pg_cron')
    );
    RAISE LOG '[campaign-heads-up] sweep enqueued url=%', v_url;
  EXCEPTION WHEN OTHERS THEN
    RAISE LOG '[campaign-heads-up] sweep failed sqlerrm=%', SQLERRM;
  END;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.campaign_heads_up_due_sweep() TO service_role;
