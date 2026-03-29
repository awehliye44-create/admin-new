INSERT INTO public.service_area_vehicle_pricing (service_area_id, vehicle_type_id, is_enabled, currency_code, base_fare, minimum_fare)
VALUES
  ('dcd095fc-8847-491d-895a-c37443ae89c0', 'df83cc66-b124-49b1-99db-c8089a9ebe62', true, 'INR', 45, 80),
  ('dcd095fc-8847-491d-895a-c37443ae89c0', 'e494cb7b-dc80-4182-ae4e-5b6ed6b5a4f8', true, 'INR', 50, 90),
  ('dcd095fc-8847-491d-895a-c37443ae89c0', '6a7f2666-7531-4e0d-87c9-912f68200615', true, 'INR', 35, 70),
  ('dcd095fc-8847-491d-895a-c37443ae89c0', 'bba011d5-6ed1-4d25-8c5c-e0d8d4a33b90', true, 'INR', 40, 75)
ON CONFLICT DO NOTHING;