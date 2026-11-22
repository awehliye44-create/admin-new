-- #79A — Durable customer trip lifecycle notification delivery ledger.
-- First consumer: scheduled post-activation traffic_delay (one per booking).
-- Atomic UNIQUE(notification_id) claim prevents concurrent cron / on-demand
-- workers from independently sending the same logical event.
-- Status machine: sending → sent | skipped | failed | ambiguous.
-- failed is reclaimable; stuck sending past lease is reclaimable in Edge SSOT;
-- sent / skipped / ambiguous are terminal (no uncontrolled resend).

CREATE TABLE IF NOT EXISTS public.customer_trip_notification_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id text NOT NULL,
  trip_id uuid NULL REFERENCES public.trips(id) ON DELETE SET NULL,
  passenger_id uuid NULL,
  event text NOT NULL,
  status text NOT NULL CHECK (
    status IN ('sending', 'sent', 'skipped', 'failed', 'ambiguous')
  ),
  attempts integer NOT NULL DEFAULT 1 CHECK (attempts >= 0),
  skipped_reason text NULL,
  error_message text NULL,
  provider_message_id text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_trip_notification_deliveries_notification_id_uid
    UNIQUE (notification_id)
);

CREATE INDEX IF NOT EXISTS customer_trip_notification_deliveries_trip_idx
  ON public.customer_trip_notification_deliveries (trip_id);

CREATE INDEX IF NOT EXISTS customer_trip_notification_deliveries_status_idx
  ON public.customer_trip_notification_deliveries (status);

CREATE INDEX IF NOT EXISTS customer_trip_notification_deliveries_event_idx
  ON public.customer_trip_notification_deliveries (event);

ALTER TABLE public.customer_trip_notification_deliveries ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.customer_trip_notification_deliveries FROM PUBLIC;
REVOKE ALL ON public.customer_trip_notification_deliveries FROM anon;
REVOKE ALL ON public.customer_trip_notification_deliveries FROM authenticated;
GRANT ALL ON public.customer_trip_notification_deliveries TO service_role;

COMMENT ON TABLE public.customer_trip_notification_deliveries IS
  'Idempotent delivery ledger for customer trip lifecycle pushes (e.g. scheduled traffic_delay). UNIQUE(notification_id) is the concurrency claim.';

-- Historical protection (#79): ops_alerts prove prior customer traffic_delay floods.
-- Seed terminal receipts so redeploy cannot replay those notifications.
-- Do not invent provider delivery confirmation — mark sent with reconcile metadata.
INSERT INTO public.customer_trip_notification_deliveries (
  notification_id,
  trip_id,
  event,
  status,
  attempts,
  skipped_reason,
  metadata,
  created_at,
  updated_at
)
SELECT
  'traffic_delay_scheduled:' || oa.related_trip_id::text,
  oa.related_trip_id,
  'traffic_delay',
  'sent',
  GREATEST(1, COALESCE(oa.fingerprint_count, 1)),
  'historical_ops_alert_reconcile',
  jsonb_build_object(
    'source', 'ops_alerts',
    'fingerprint', oa.fingerprint,
    'fingerprint_count', oa.fingerprint_count,
    'reconcile', 'bug79a_historical_protection',
    'delivery_confirmation', 'not_invented'
  ),
  COALESCE(oa.created_at, now()),
  COALESCE(oa.updated_at, oa.created_at, now())
FROM public.ops_alerts oa
WHERE oa.fingerprint LIKE 'post_activation_lateness:%'
  AND oa.related_trip_id IS NOT NULL
  AND (
    oa.fingerprint LIKE '%:past_scheduled_pickup'
    OR oa.fingerprint LIKE '%:late_and_stale_gps'
  )
ON CONFLICT (notification_id) DO NOTHING;
