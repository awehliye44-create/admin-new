-- Reassign all NAI trips to Milton Keynes (MK) service area with new MK trip numbers
-- MK sequence is currently at 270, so new trips will be MK271-MK280

-- Update trips: reassign service area, code, and trip numbers
UPDATE trips SET
  service_area_id = 'cb58f1bd-8b6f-45b9-ad31-b3140309892c',
  service_area_code = 'MK',
  trip_number = 'MK' || LPAD((270 + row_num)::text, 3, '0'),
  sequence_no = 270 + row_num,
  updated_at = now()
FROM (
  SELECT id as tid, ROW_NUMBER() OVER (ORDER BY created_at ASC) as row_num
  FROM trips
  WHERE service_area_id = '39ca8fbc-6ede-4553-bc87-346921d5abb5'
) sub
WHERE trips.id = sub.tid;

-- Update MK sequence counter to reflect the new total
UPDATE service_area_sequences
SET current_value = 280, updated_at = now()
WHERE service_area_id = 'cb58f1bd-8b6f-45b9-ad31-b3140309892c'
  AND sequence_type = 'trip';

-- Delete the NAI sequence since it's no longer valid
DELETE FROM service_area_sequences
WHERE service_area_id = '39ca8fbc-6ede-4553-bc87-346921d5abb5';