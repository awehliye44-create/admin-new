-- DT1 — Durable Driver tip-received heads-up (separate from SN1).
-- Intent is inserted in the SAME transaction as DRIVER_TIP_CREDIT via trigger.
-- No historical backfill — only new tip credits after this migration.
-- Provider send stays async (Edge deliver + reclaim).

CREATE TABLE IF NOT EXISTS public.driver_tip_notification_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id text NOT NULL,
  ledger_id uuid NOT NULL,
  trip_id uuid NULL REFERENCES public.trips(id) ON DELETE SET NULL,
  driver_id uuid NOT NULL,
  tip_pence integer NOT NULL CHECK (tip_pence > 0),
  event text NOT NULL DEFAULT 'driver_tip_received',
  status text NOT NULL CHECK (
    status IN ('pending', 'sending', 'sent', 'skipped', 'failed', 'ambiguous')
  ),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  skipped_reason text NULL,
  error_message text NULL,
  provider_message_id text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT driver_tip_notification_deliveries_notification_id_uid
    UNIQUE (notification_id),
  CONSTRAINT driver_tip_notification_deliveries_ledger_uid
    UNIQUE (ledger_id)
);

CREATE INDEX IF NOT EXISTS driver_tip_notification_deliveries_recovery_idx
  ON public.driver_tip_notification_deliveries (status, updated_at)
  WHERE status IN ('pending', 'sending', 'failed');

CREATE INDEX IF NOT EXISTS driver_tip_notification_deliveries_driver_idx
  ON public.driver_tip_notification_deliveries (driver_id);

ALTER TABLE public.driver_tip_notification_deliveries ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.driver_tip_notification_deliveries FROM PUBLIC;
REVOKE ALL ON public.driver_tip_notification_deliveries FROM anon;
REVOKE ALL ON public.driver_tip_notification_deliveries FROM authenticated;
GRANT ALL ON public.driver_tip_notification_deliveries TO service_role;

COMMENT ON TABLE public.driver_tip_notification_deliveries IS
  'DT1: idempotent Driver tip-received push ledger. UNIQUE(notification_id) + UNIQUE(ledger_id). pending = durable intent; ambiguous terminal.';

CREATE OR REPLACE FUNCTION public.trg_dt1_driver_tip_credit_notify_intent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_notif text;
  v_now timestamptz := now();
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RETURN NEW;
  END IF;
  IF upper(COALESCE(NEW.type, '')) <> 'DRIVER_TIP_CREDIT' THEN
    RETURN NEW;
  END IF;
  IF NEW.driver_id IS NULL OR NEW.id IS NULL THEN
    RETURN NEW;
  END IF;
  IF COALESCE(NEW.amount_pence, 0) <= 0 THEN
    RETURN NEW;
  END IF;

  v_notif := 'driver_tip_received:' || NEW.id::text;

  INSERT INTO public.driver_tip_notification_deliveries (
    notification_id,
    ledger_id,
    trip_id,
    driver_id,
    tip_pence,
    event,
    status,
    attempts,
    metadata,
    created_at,
    updated_at
  ) VALUES (
    v_notif,
    NEW.id,
    NEW.related_trip_id,
    NEW.driver_id,
    NEW.amount_pence,
    'driver_tip_received',
    'pending',
    0,
    jsonb_build_object(
      'source', 'trg_dt1_driver_tip_credit_notify_intent',
      'delivery_confirmation', 'not_device_heads_up',
      'path', '/wallet?ledgerId=' || NEW.id::text
    ),
    v_now,
    v_now
  )
  ON CONFLICT (notification_id) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_dt1_driver_tip_credit_notify_intent ON public.driver_wallet_ledger;
CREATE TRIGGER trg_dt1_driver_tip_credit_notify_intent
  AFTER INSERT ON public.driver_wallet_ledger
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_dt1_driver_tip_credit_notify_intent();

COMMENT ON FUNCTION public.trg_dt1_driver_tip_credit_notify_intent() IS
  'DT1: same-txn pending Driver tip heads-up intent when DRIVER_TIP_CREDIT posts. No historical backfill.';
