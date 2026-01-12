-- Update driver Ahmed Osman to be online with a location (Milton Keynes, UK area)
UPDATE drivers 
SET 
  is_online = true,
  current_lat = 52.0406,
  current_lng = -0.7594,
  heading = 45,
  speed = 15,
  last_location_updated_at = now()
WHERE id = '4936c384-fd47-4d75-8858-0d8a4d851542';