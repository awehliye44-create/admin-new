-- Allow Admin Alert Sounds SSOT uploads as WAV (native apps install/play WAV).
-- Bucket previously allowed audio/mpeg only.

UPDATE storage.buckets
SET allowed_mime_types = ARRAY[
  'audio/mpeg',
  'audio/wav',
  'audio/wave',
  'audio/x-wav'
]
WHERE id = 'alert-sounds';
