
ALTER TABLE public.payment_sessions
  ADD COLUMN IF NOT EXISTS parent_session_id UUID REFERENCES public.payment_sessions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS recovery_reason TEXT,
  ADD COLUMN IF NOT EXISTS provider_checkout_url TEXT;

CREATE INDEX IF NOT EXISTS payment_sessions_parent_session_idx
  ON public.payment_sessions(parent_session_id);

CREATE UNIQUE INDEX IF NOT EXISTS payment_sessions_recovery_completed_unique
  ON public.payment_sessions(trip_id)
  WHERE purpose = 'PAYMENT_RECOVERY' AND status = 'RECOVERY_COMPLETED';

CREATE UNIQUE INDEX IF NOT EXISTS payment_sessions_recovery_open_unique
  ON public.payment_sessions(trip_id)
  WHERE purpose = 'PAYMENT_RECOVERY'
    AND status IN ('RECOVERY_CHECKOUT_CREATED', 'CUSTOMER_ACTION_REQUIRED');
