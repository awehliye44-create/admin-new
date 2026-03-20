
-- QR Booking Config - single-row config table
CREATE TABLE public.qr_booking_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pickup_name text NOT NULL DEFAULT '',
  pickup_address text NOT NULL DEFAULT '',
  pickup_lat double precision NOT NULL DEFAULT 0,
  pickup_lng double precision NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'disabled' CHECK (status IN ('active', 'disabled')),
  qr_url text NOT NULL DEFAULT 'https://guest.onecab.net?source=qr',
  updated_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Ensure only one row
CREATE UNIQUE INDEX qr_booking_config_singleton ON public.qr_booking_config ((true));

-- Seed initial row
INSERT INTO public.qr_booking_config (pickup_name, pickup_address, pickup_lat, pickup_lng, status)
VALUES ('', '', 0, 0, 'disabled');

-- Audit log for QR config changes
CREATE TABLE public.qr_booking_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  changed_by uuid REFERENCES auth.users(id),
  changed_by_email text,
  old_values jsonb NOT NULL DEFAULT '{}',
  new_values jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- RLS
ALTER TABLE public.qr_booking_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.qr_booking_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can read qr_booking_config"
  ON public.qr_booking_config FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "Admins can update qr_booking_config"
  ON public.qr_booking_config FOR UPDATE TO authenticated
  USING (true) WITH CHECK (true);

CREATE POLICY "Admins can read qr_booking_audit_log"
  ON public.qr_booking_audit_log FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "Admins can insert qr_booking_audit_log"
  ON public.qr_booking_audit_log FOR INSERT TO authenticated
  WITH CHECK (true);

-- Auto-update updated_at
CREATE TRIGGER update_qr_booking_config_updated_at
  BEFORE UPDATE ON public.qr_booking_config
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
