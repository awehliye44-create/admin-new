-- Insert pending driver using existing user
INSERT INTO public.drivers (
  user_id,
  first_name,
  last_name,
  email,
  phone,
  region_id,
  approval_status,
  is_online,
  rating,
  total_trips
) VALUES (
  'abf3f4f6-a559-4df0-906b-3b797660a697',
  'Driver',
  'Awaiting Approval',
  'awehliye44@gmail.com',
  '+254700000000',
  'dcb6b42e-4d2b-45b6-af71-43ffbb3767d6',
  'pending',
  false,
  5.0,
  0
);