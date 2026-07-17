-- Phase 2 harden: one welcome credit per driver per service area (race-safe).
CREATE UNIQUE INDEX IF NOT EXISTS driver_commission_wallet_ledger_welcome_uidx
  ON public.driver_commission_wallet_ledger (driver_id, service_area_id)
  WHERE entry_type = 'WELCOME_CREDIT';
