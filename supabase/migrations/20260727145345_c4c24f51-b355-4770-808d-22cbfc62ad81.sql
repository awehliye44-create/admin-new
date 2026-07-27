DELETE FROM public.alert_sound_mappings
WHERE (target_app = 'driver' AND event_type IN ('payment_received', 'warning'))
   OR (target_app = 'customer' AND event_type = 'payment_status');