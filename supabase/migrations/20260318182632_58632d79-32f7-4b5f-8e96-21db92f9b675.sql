
-- Alert sounds table
CREATE TABLE public.alert_sounds (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'audio/mpeg',
  file_size INTEGER,
  duration NUMERIC,
  target_app TEXT NOT NULL DEFAULT 'global' CHECK (target_app IN ('driver', 'customer', 'global')),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.alert_sounds ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can manage alert sounds"
  ON public.alert_sounds FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- Alert sound mappings table
CREATE TABLE public.alert_sound_mappings (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  target_app TEXT NOT NULL CHECK (target_app IN ('driver', 'customer')),
  event_type TEXT NOT NULL,
  alert_sound_id UUID REFERENCES public.alert_sounds(id) ON DELETE CASCADE NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (target_app, event_type)
);

ALTER TABLE public.alert_sound_mappings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can manage alert sound mappings"
  ON public.alert_sound_mappings FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- Public read for mobile apps
CREATE POLICY "Anyone can read active mappings"
  ON public.alert_sound_mappings FOR SELECT TO anon, authenticated
  USING (is_active = true);

CREATE POLICY "Anyone can read active sounds"
  ON public.alert_sounds FOR SELECT TO anon, authenticated
  USING (is_active = true);

-- Updated_at triggers
CREATE TRIGGER update_alert_sounds_updated_at
  BEFORE UPDATE ON public.alert_sounds
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_alert_sound_mappings_updated_at
  BEFORE UPDATE ON public.alert_sound_mappings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Storage bucket for alert sounds
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('alert-sounds', 'alert-sounds', true, 10485760, ARRAY['audio/mpeg']);

-- Storage policies
CREATE POLICY "Admins can upload alert sounds"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'alert-sounds' AND public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can update alert sounds"
  ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'alert-sounds' AND public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can delete alert sounds"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'alert-sounds' AND public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Anyone can read alert sounds"
  ON storage.objects FOR SELECT TO anon, authenticated
  USING (bucket_id = 'alert-sounds');
