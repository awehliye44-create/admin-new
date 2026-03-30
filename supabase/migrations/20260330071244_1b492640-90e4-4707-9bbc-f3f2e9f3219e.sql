SELECT cron.schedule(
  'schedule-dispatch-every-minute',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := 'https://thazislrdkjpvvghtvzo.supabase.co/functions/v1/schedule-dispatch',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRoYXppc2xyZGtqcHZ2Z2h0dnpvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc4NzA1MjIsImV4cCI6MjA4MzQ0NjUyMn0.pXaycIz1t7JXuItyqvjNNrFsZpsaXbB5bV1OWSQLbWM"}'::jsonb,
    body := concat('{"time": "', now(), '"}')::jsonb
  ) AS request_id;
  $$
);