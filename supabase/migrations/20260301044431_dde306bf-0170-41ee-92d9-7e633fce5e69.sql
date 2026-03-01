
-- Add new columns to driver_categories (non-destructive, keeps existing columns)
ALTER TABLE public.driver_categories
  ADD COLUMN IF NOT EXISTS commission_pct numeric(5,2) DEFAULT 20.00,
  ADD COLUMN IF NOT EXISTS trip_target integer,
  ADD COLUMN IF NOT EXISTS level_order integer DEFAULT 0;

-- Add category_id and commission_override_pct to drivers
ALTER TABLE public.drivers
  ADD COLUMN IF NOT EXISTS category_id uuid REFERENCES public.driver_categories(id),
  ADD COLUMN IF NOT EXISTS commission_override_pct numeric(5,2);

-- Seed the 5 fixed categories if they don't exist
INSERT INTO public.driver_categories (name, description, level_order, commission_pct, display_order, is_active, icon, color)
VALUES 
  ('Bronze',   'Entry level driver tier',   1, 25.00, 1, true, 'shield',   '#CD7F32'),
  ('Silver',   'Intermediate driver tier',   2, 22.00, 2, true, 'shield',   '#C0C0C0'),
  ('Gold',     'Experienced driver tier',    3, 20.00, 3, true, 'star',     '#FFD700'),
  ('Platinum', 'Premium driver tier',        4, 18.00, 4, true, 'crown',    '#E5E4E2'),
  ('Diamond',  'Elite driver tier',          5, 15.00, 5, true, 'sparkles', '#B9F2FF')
ON CONFLICT DO NOTHING;

-- Create updated_at trigger for driver_categories if not exists
CREATE OR REPLACE TRIGGER update_driver_categories_updated_at
  BEFORE UPDATE ON public.driver_categories
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
