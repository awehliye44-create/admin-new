
-- Schedule ops detection every 5 minutes via pg_cron + pg_net
SELECT cron.schedule(
  'ops-run-detections-every-5min',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://thazislrdkjpvvghtvzo.supabase.co/functions/v1/ops-run-detections',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRoYXppc2xyZGtqcHZ2Z2h0dnpvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc4NzA1MjIsImV4cCI6MjA4MzQ0NjUyMn0.pXaycIz1t7JXuItyqvjNNrFsZpsaXbB5bV1OWSQLbWM"}'::jsonb,
    body := concat('{"source":"cron","time":"', now(), '"}')::jsonb
  ) AS request_id;
  $$
);
