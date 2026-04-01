
-- Audit log for AI fix actions
CREATE TABLE public.ops_fix_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id UUID NOT NULL,
  action_type TEXT NOT NULL,
  function_name TEXT NOT NULL,
  input_payload JSONB NOT NULL DEFAULT '{}',
  result JSONB,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','success','failed')),
  risk_level TEXT NOT NULL DEFAULT 'LOW' CHECK (risk_level IN ('LOW','MEDIUM','HIGH')),
  ai_explanation TEXT,
  preview_data JSONB,
  executed_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.ops_fix_actions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read ops_fix_actions"
  ON public.ops_fix_actions FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can insert ops_fix_actions"
  ON public.ops_fix_actions FOR INSERT TO authenticated WITH CHECK (auth.uid() = executed_by);

CREATE POLICY "Authenticated users can update own ops_fix_actions"
  ON public.ops_fix_actions FOR UPDATE TO authenticated USING (auth.uid() = executed_by);

CREATE INDEX idx_ops_fix_actions_alert ON public.ops_fix_actions(alert_id);
CREATE INDEX idx_ops_fix_actions_status ON public.ops_fix_actions(status);

-- ==========================================
-- SAFE REPAIR FUNCTIONS (idempotent)
-- ==========================================

-- 1. Repair missing commission for a trip
CREATE OR REPLACE FUNCTION public.ops_repair_missing_commission(p_trip_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_trip RECORD;
  v_existing RECORD;
  v_result JSONB;
BEGIN
  SELECT id, driver_id, final_fare_pence, payment_method, status, service_area_id
    INTO v_trip FROM trips WHERE id = p_trip_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Trip not found');
  END IF;
  IF v_trip.status != 'completed' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Trip is not completed');
  END IF;

  -- Check if commission already exists
  SELECT id INTO v_existing FROM trip_finance WHERE trip_id = p_trip_id;
  IF FOUND THEN
    RETURN jsonb_build_object('success', true, 'message', 'Commission already exists', 'affected_rows', 0);
  END IF;

  -- Calculate commission at default 20%
  INSERT INTO trip_finance (trip_id, driver_id, fare_pence, commission_pct, commission_pence, driver_earning_pence, payment_method, currency_code)
  VALUES (
    p_trip_id, v_trip.driver_id, v_trip.final_fare_pence, 20,
    ROUND(v_trip.final_fare_pence * 0.20), ROUND(v_trip.final_fare_pence * 0.80),
    v_trip.payment_method, COALESCE((SELECT currency_code FROM service_areas WHERE id = v_trip.service_area_id), 'GBP')
  );

  RETURN jsonb_build_object('success', true, 'message', 'Commission created', 'affected_rows', 1,
    'trip_id', p_trip_id, 'commission_pence', ROUND(v_trip.final_fare_pence * 0.20));
END;
$$;

-- 2. Repair missing driver earning ledger entry
CREATE OR REPLACE FUNCTION public.ops_repair_missing_driver_earning(p_trip_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_trip RECORD;
  v_finance RECORD;
  v_existing RECORD;
BEGIN
  SELECT id, driver_id, final_fare_pence, status INTO v_trip FROM trips WHERE id = p_trip_id;
  IF NOT FOUND OR v_trip.status != 'completed' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Trip not found or not completed');
  END IF;

  SELECT * INTO v_finance FROM trip_finance WHERE trip_id = p_trip_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'trip_finance missing - run repair_missing_commission first');
  END IF;

  -- Check existing ledger entry
  SELECT id INTO v_existing FROM driver_ledger WHERE trip_id = p_trip_id AND entry_type = 'TRIP_EARNING_NET';
  IF FOUND THEN
    RETURN jsonb_build_object('success', true, 'message', 'Earning already exists', 'affected_rows', 0);
  END IF;

  INSERT INTO driver_ledger (driver_id, trip_id, entry_type, amount_pence, currency_code, description)
  VALUES (v_trip.driver_id, p_trip_id, 'TRIP_EARNING_NET', v_finance.driver_earning_pence,
    v_finance.currency_code, 'Repair: missing earning for trip ' || p_trip_id::text);

  RETURN jsonb_build_object('success', true, 'message', 'Earning ledger entry created', 'affected_rows', 1,
    'amount_pence', v_finance.driver_earning_pence);
END;
$$;

-- 3. Repair missing financials (commission + earning + company commission)
CREATE OR REPLACE FUNCTION public.ops_repair_missing_financials(p_trip_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_r1 JSONB;
  v_r2 JSONB;
  v_trip RECORD;
  v_finance RECORD;
  v_existing RECORD;
BEGIN
  v_r1 := public.ops_repair_missing_commission(p_trip_id);
  v_r2 := public.ops_repair_missing_driver_earning(p_trip_id);

  -- Also ensure COMPANY_COMMISSION ledger entry
  SELECT * INTO v_finance FROM trip_finance WHERE trip_id = p_trip_id;
  IF FOUND THEN
    SELECT id INTO v_existing FROM driver_ledger WHERE trip_id = p_trip_id AND entry_type = 'COMPANY_COMMISSION';
    IF NOT FOUND THEN
      SELECT driver_id INTO v_trip FROM trips WHERE id = p_trip_id;
      INSERT INTO driver_ledger (driver_id, trip_id, entry_type, amount_pence, currency_code, description)
      VALUES (v_trip.driver_id, p_trip_id, 'COMPANY_COMMISSION', v_finance.commission_pence,
        v_finance.currency_code, 'Repair: company commission for trip ' || p_trip_id::text);
    END IF;
  END IF;

  RETURN jsonb_build_object('success', true, 'commission_result', v_r1, 'earning_result', v_r2);
END;
$$;

-- 4. Retry failed dispatch (reset stuck trip)
CREATE OR REPLACE FUNCTION public.ops_retry_failed_dispatch(p_trip_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_trip RECORD;
BEGIN
  SELECT id, status INTO v_trip FROM trips WHERE id = p_trip_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Trip not found');
  END IF;
  IF v_trip.status NOT IN ('pending', 'driver_assigned') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Trip status is ' || v_trip.status || ', cannot retry dispatch');
  END IF;

  UPDATE trips SET status = 'pending', driver_id = NULL, updated_at = now() WHERE id = p_trip_id;

  RETURN jsonb_build_object('success', true, 'message', 'Trip reset to pending for re-dispatch', 'affected_rows', 1);
END;
$$;

-- 5. Resolve alert if condition cleared
CREATE OR REPLACE FUNCTION public.ops_resolve_alert_if_cleared(p_alert_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_alert RECORD;
BEGIN
  SELECT id, status INTO v_alert FROM ops_alerts WHERE id = p_alert_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Alert not found');
  END IF;
  IF v_alert.status = 'resolved' THEN
    RETURN jsonb_build_object('success', true, 'message', 'Already resolved', 'affected_rows', 0);
  END IF;

  UPDATE ops_alerts SET status = 'resolved', resolved_at = now(), updated_at = now() WHERE id = p_alert_id;

  RETURN jsonb_build_object('success', true, 'message', 'Alert resolved', 'affected_rows', 1);
END;
$$;

-- 6. Replay webhook (mark for retry)
CREATE OR REPLACE FUNCTION public.ops_replay_webhook(p_event_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_evt RECORD;
BEGIN
  SELECT id, status INTO v_evt FROM webhook_events WHERE id = p_event_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Webhook event not found');
  END IF;

  UPDATE webhook_events SET status = 'pending', retry_count = 0, updated_at = now() WHERE id = p_event_id;

  RETURN jsonb_build_object('success', true, 'message', 'Webhook event queued for retry', 'affected_rows', 1);
END;
$$;

-- 7. Retry failed payout
CREATE OR REPLACE FUNCTION public.ops_retry_failed_payout(p_payout_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_payout RECORD;
BEGIN
  SELECT id, status INTO v_payout FROM payout_batches WHERE id = p_payout_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Payout not found');
  END IF;
  IF v_payout.status NOT IN ('failed', 'error') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Payout status is ' || v_payout.status || ', not eligible for retry');
  END IF;

  UPDATE payout_batches SET status = 'pending', updated_at = now() WHERE id = p_payout_id;

  RETURN jsonb_build_object('success', true, 'message', 'Payout reset to pending', 'affected_rows', 1);
END;
$$;
