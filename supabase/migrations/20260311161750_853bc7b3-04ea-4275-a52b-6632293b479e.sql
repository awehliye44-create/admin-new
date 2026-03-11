
-- Enable RLS on staff_id_sequences (internal table, only managed by triggers)
ALTER TABLE public.staff_id_sequences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff ID sequences viewable by authenticated" ON public.staff_id_sequences
  FOR SELECT TO authenticated USING (true);
