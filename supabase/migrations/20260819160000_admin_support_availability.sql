-- Admin support availability heartbeat table.
-- The admin app writes a heartbeat every 30s while an admin is signed in and active.
-- The public edge function admin-support-status reads this to tell the website
-- whether an admin is currently available for support.
--
-- Only one row ever exists (upserted via fixed id = 'singleton').
-- Stale threshold: 2 minutes (4 missed 30-second heartbeats = unavailable).

CREATE TABLE IF NOT EXISTS public.admin_support_availability (
  id            TEXT PRIMARY KEY DEFAULT 'singleton',
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  admin_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS: only admins (has_role = 'admin') can write; read is denied via RLS
-- (the edge function uses service role to read).
ALTER TABLE public.admin_support_availability ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can upsert availability heartbeat"
  ON public.admin_support_availability
  FOR ALL
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

-- No public SELECT policy — the status edge function reads via service role key.
