-- #110 P4B: WINDOW_EXPIRED fallback sweep every 5 seconds (was every minute).
-- has_work gate keeps empty ticks cheap. Customer SKIP/SUBMIT remain the primary path.
-- Sweeps must not be the normal settlement path — only catch abandoned tip windows.

DO $$
BEGIN
  PERFORM cron.unschedule('capture-expired-tip-windows-sweep');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'capture-expired-tip-windows-sweep',
  '5 seconds',
  $$SELECT public.capture_expired_tip_windows_sweep()$$
);
