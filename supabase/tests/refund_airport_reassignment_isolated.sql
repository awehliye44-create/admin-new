-- Throwaway proof for refund idempotency, airport fee basis, and reassignment.
-- Uses the production function bodies. Does not connect to a shared database.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE public.drivers (
  id uuid PRIMARY KEY,
  user_id uuid,
  payout_operational_paused boolean NOT NULL DEFAULT false
);

CREATE TABLE public.trips (
  id uuid PRIMARY KEY,
  driver_id uuid,
  confirmed_driver_id uuid,
  previous_driver_id uuid,
  status text,
  payment_status text,
  financial_model text,
  payment_collection_model text,
  payment_method text,
  capture_amount_pence integer,
  commission_pence integer,
  driver_net_pence integer,
  airport_charge_pence integer,
  final_fare_pence integer,
  final_customer_fare_pence integer,
  tip_pence integer,
  tip_amount_pence integer,
  financial_outcome text,
  no_show_charge_pence integer,
  currency text DEFAULT 'GBP',
  refund_amount_pence integer,
  refunded_at timestamptz,
  refund_reason text,
  completed_at timestamptz,
  cancelled_at timestamptz,
  payment_session_id uuid,
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE public.payment_sessions (
  id uuid PRIMARY KEY,
  trip_id uuid,
  purpose text,
  payment_provider text,
  status text,
  captured_amount_pence integer,
  authorised_amount_pence integer,
  currency text,
  refunded_amount_pence integer,
  refunded_at timestamptz,
  provider_refund_id text,
  provider_order_id text,
  provider_state text,
  payment_method text,
  provider_processing_fee_pence integer,
  fee_status text,
  captured_at timestamptz,
  metadata jsonb,
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE public.payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid,
  driver_id uuid,
  amount_pence integer,
  captured_amount_pence integer,
  status text,
  refunded_amount_pence integer,
  refund_status text,
  refunded_at timestamptz,
  updated_at timestamptz DEFAULT now(),
  provider_refund_id text,
  last_error text
);

CREATE TABLE public.trip_finance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid,
  driver_id uuid,
  financial_status text,
  refund_amount_pence integer,
  refund_status text,
  net_card_revenue_after_refund_pence integer,
  driver_wallet_reversal_pence integer,
  commission_reversal_pence integer,
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE public.driver_wallet_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid,
  related_trip_id uuid,
  type text,
  amount_pence integer,
  currency text,
  description text,
  payment_provider text,
  provider_refund_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.payment_session_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_session_id uuid,
  payment_provider text,
  provider_refund_id text,
  provider_payment_id text,
  amount_pence integer,
  currency text,
  status text,
  confirmed_at timestamptz,
  metadata jsonb
);

CREATE UNIQUE INDEX payment_session_refunds_provider_refund_unique
  ON public.payment_session_refunds (payment_provider, provider_refund_id);

CREATE UNIQUE INDEX driver_wallet_ledger_refund_debit_provider_refund_unique
  ON public.driver_wallet_ledger (payment_provider, provider_refund_id, driver_id)
  WHERE type = 'REFUND_DEBIT' AND provider_refund_id IS NOT NULL;

CREATE TABLE public.driver_earning_settlement (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_entry_id uuid,
  settled_at timestamptz,
  settlement_status text,
  capture_time timestamptz,
  allocated_to_payout boolean,
  allocated_amount_pence integer,
  paid_in_batch_id uuid,
  paid_in_payout_item_id uuid,
  updated_at timestamptz
);

CREATE TABLE public.payout_items (
  id uuid PRIMARY KEY,
  status text,
  execution_status text
);

CREATE TABLE public.payout_item_ledger_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_entry_id uuid,
  payout_item_id uuid,
  amount_pence integer
);

CREATE FUNCTION public.assert_driver_wallet_read_access(uuid) RETURNS void LANGUAGE sql AS $$ SELECT NULL::void $$;
CREATE FUNCTION public.driver_wallet_live_balance_pence(uuid) RETURNS bigint LANGUAGE sql AS $$ SELECT 100000::bigint $$;
CREATE FUNCTION public.driver_wallet_active_reservation_pence(uuid) RETURNS bigint LANGUAGE sql AS $$ SELECT 0::bigint $$;
CREATE FUNCTION public.driver_wallet_other_holds_pence(uuid) RETURNS bigint LANGUAGE sql AS $$ SELECT 0::bigint $$;
CREATE FUNCTION public.driver_wallet_payout_clearing_delay_hours() RETURNS numeric LANGUAGE sql AS $$ SELECT 0::numeric $$;
CREATE FUNCTION public.driver_wallet_stable_clearing_origin(timestamptz, timestamptz, timestamptz, timestamptz, timestamptz)
  RETURNS timestamptz LANGUAGE sql AS $$ SELECT now() - interval '3 hours' $$;
CREATE FUNCTION public.trip_chargeable_terminal_outcome_kind(text, text, text, integer)
  RETURNS text LANGUAGE sql AS $$ SELECT NULL::text $$;
CREATE FUNCTION public.payout_item_status_releases_ledger_allocation(text, text)
  RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
CREATE FUNCTION public.trip_terminal_entitled_driver_id(uuid, uuid, uuid)
  RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT COALESCE($2, $1, $3) $$;
