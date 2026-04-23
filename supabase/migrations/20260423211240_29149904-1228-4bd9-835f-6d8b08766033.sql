ALTER TABLE public.lost_property_sequences
  DROP CONSTRAINT IF EXISTS lost_property_sequences_service_area_id_fkey,
  ADD CONSTRAINT lost_property_sequences_service_area_id_fkey
    FOREIGN KEY (service_area_id) REFERENCES public.service_areas(id) ON DELETE CASCADE;

ALTER TABLE public.complaint_sequences
  DROP CONSTRAINT IF EXISTS complaint_sequences_service_area_id_fkey,
  ADD CONSTRAINT complaint_sequences_service_area_id_fkey
    FOREIGN KEY (service_area_id) REFERENCES public.service_areas(id) ON DELETE CASCADE;