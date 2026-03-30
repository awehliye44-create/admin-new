ALTER TABLE public.qr_booking_config
  ADD COLUMN IF NOT EXISTS allow_cash boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS allow_card boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS allow_apple_pay boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS allow_google_pay boolean NOT NULL DEFAULT true;