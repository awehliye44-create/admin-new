
ALTER TABLE public.dispatch_settings DROP CONSTRAINT driver_fare_display_check;
ALTER TABLE public.dispatch_settings ADD CONSTRAINT driver_fare_display_check 
  CHECK (driver_fare_display = ANY (ARRAY['net_earnings'::text, 'gross_fare'::text, 'smart_display'::text, 'full_breakdown'::text]));
