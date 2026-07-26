UPDATE public.alert_sounds AS a
SET storage_path = regexp_replace(a.storage_path, '\.mp3$', '.wav'),
    mime_type = 'audio/wav',
    file_size = v.size,
    updated_at = now()
FROM (VALUES
  ('182f6aca-a30a-4126-a929-5a4bf0a89c7e.mp3', 338766),
  ('1e124e2a-c36d-4a6a-b5bd-d2323bcf3cbb.mp3', 884430),
  ('4999b2fe-c17c-444a-9869-a16eb2f8ea04.mp3', 884430),
  ('7f6af1ac-26b2-4639-8c34-47b89a4e2ffc.mp3', 322186),
  ('800fb59a-9893-42b2-8617-4d4c7bcbae5a.mp3', 322186),
  ('8d24e75a-b163-4d2e-ab66-cffde87ed84c.mp3', 3799562),
  ('93fc1df1-32e9-4ef0-a769-db9c8ee3fd91.mp3', 884430),
  ('ab1e6dcc-e7a7-4dfb-8e7a-014494834d94.mp3', 884430),
  ('b1dd4656-5dda-4cb1-8170-62ced6117dee.mp3', 312426)
) AS v(path, size)
WHERE a.storage_path = v.path;

ALTER TABLE public.alert_sounds ALTER COLUMN mime_type SET DEFAULT 'audio/wav';

ALTER TABLE public.alert_sounds
  ADD CONSTRAINT alert_sounds_wav_only_check
  CHECK (mime_type IN ('audio/wav', 'audio/x-wav', 'audio/wave')
         AND storage_path ILIKE '%.wav');