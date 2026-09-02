-- Final read-only health audit (no mutations, no RPC execution)

-- === I. Red flag DB queries ===

-- 1) duplicate TRIP_EARNING_NET per trip
SELECT 'dup_trip_earning_net' AS check_id, t.trip_code, t.id AS trip_id, COUNT(*) AS cnt
FROM driver_wallet_ledger l
JOIN trips t ON t.id = l.related_trip_id
WHERE upper(btrim(l.type)) = 'TRIP_EARNING_NET' AND l.amount_pence > 0
GROUP BY t.trip_code, t.id
HAVING COUNT(*) > 1
ORDER BY cnt DESC
LIMIT 20;

-- 2) trip with both TRIP_EARNING_NET and DRIVER_COMPENSATION_CREDIT
SELECT 'trip_earning_and_comp' AS check_id, t.trip_code, t.id AS trip_id,
       bool_or(upper(btrim(l.type)) = 'TRIP_EARNING_NET') AS has_ten,
       bool_or(upper(btrim(l.type)) = 'DRIVER_COMPENSATION_CREDIT') AS has_dcc
FROM driver_wallet_ledger l
JOIN trips t ON t.id = l.related_trip_id
WHERE upper(btrim(l.type)) IN ('TRIP_EARNING_NET', 'DRIVER_COMPENSATION_CREDIT')
GROUP BY t.trip_code, t.id
HAVING bool_or(upper(btrim(l.type)) = 'TRIP_EARNING_NET')
   AND bool_or(upper(btrim(l.type)) = 'DRIVER_COMPENSATION_CREDIT')
LIMIT 20;

-- 3) completed payout item without wallet debit
SELECT 'completed_no_wallet_debit' AS check_id, pi.id AS payout_item_id, dr.driver_code, pi.status, pi.net_driver_payout_pence
FROM payout_items pi
LEFT JOIN drivers dr ON dr.id = pi.driver_id
WHERE lower(btrim(COALESCE(pi.status, ''))) IN ('completed', 'paid')
AND NOT EXISTS (
  SELECT 1 FROM driver_wallet_ledger dwl
  WHERE dwl.driver_id = pi.driver_id
    AND dwl.amount_pence < 0
    AND upper(btrim(dwl.type)) IN ('PAYOUT_DEBIT', 'WITHDRAWAL_DEBIT', 'EARLY_CASHOUT_DEBIT', 'DRIVER_PAYOUT_DEBIT')
    AND (
      pi.ledger_entry_id = dwl.id
      OR EXISTS (
        SELECT 1 FROM driver_payout_reservations r
        WHERE r.payout_item_id = pi.id AND (r.debit_ledger_entry_id = dwl.id OR r.hold_ledger_entry_id = dwl.id)
      )
    )
)
LIMIT 20;

-- 4) wallet payout debit without completed payout item
SELECT 'wallet_debit_no_completed_item' AS check_id, dwl.id AS ledger_id, dr.driver_code, dwl.amount_pence, dwl.type
FROM driver_wallet_ledger dwl
JOIN drivers dr ON dr.id = dwl.driver_id
WHERE dwl.amount_pence < 0
  AND upper(btrim(dwl.type)) IN ('PAYOUT_DEBIT', 'WITHDRAWAL_DEBIT', 'EARLY_CASHOUT_DEBIT', 'DRIVER_PAYOUT_DEBIT')
  AND NOT EXISTS (
    SELECT 1 FROM payout_items pi
    WHERE lower(btrim(COALESCE(pi.status, ''))) IN ('completed', 'paid')
      AND (
        pi.ledger_entry_id = dwl.id
        OR EXISTS (
          SELECT 1 FROM driver_payout_reservations r
          WHERE r.payout_item_id = pi.id AND (r.debit_ledger_entry_id = dwl.id OR r.hold_ledger_entry_id = dwl.id)
        )
      )
  )
LIMIT 20;

-- 5) provider completed but item not completed
SELECT 'provider_done_item_not' AS check_id, pi.id AS payout_item_id, pi.status, i.provider_state, i.execution_status
FROM payout_items pi
JOIN driver_payout_payment_intents i ON i.payout_item_id = pi.id
WHERE lower(btrim(COALESCE(i.provider_state, ''))) IN ('completed', 'succeeded', 'paid')
  AND lower(btrim(COALESCE(pi.status, ''))) NOT IN ('completed', 'paid', 'cancelled', 'released', 'reversed', 'failed_permanent')
LIMIT 20;

-- 6) active reservation on completed payout
SELECT 'active_res_on_completed' AS check_id, pi.id AS payout_item_id, r.id AS reservation_id, r.status, pi.status
FROM payout_items pi
JOIN driver_payout_reservations r ON r.payout_item_id = pi.id
WHERE lower(btrim(COALESCE(pi.status, ''))) IN ('completed', 'paid')
  AND upper(btrim(COALESCE(r.status, ''))) IN ('ACTIVE', 'PENDING', 'HELD')
LIMIT 20;

-- 7) stale RUNNING occurrence
SELECT 'stale_running_occurrence' AS check_id, pb.id AS batch_id, pb.schedule_occurrence_key, pb.status, pb.updated_at
FROM payout_batches pb
WHERE lower(btrim(COALESCE(pb.status, ''))) = 'running'
  AND pb.updated_at < now() - interval '6 hours'
LIMIT 20;

-- 8) captured terminal fee with ACTUAL provider fee but no entitlement credit
SELECT 'terminal_no_entitlement' AS check_id, t.trip_code, ps.captured_amount_pence, ps.provider_processing_fee_pence, ps.fee_status
FROM trips t
JOIN payment_sessions ps ON ps.trip_id = t.id OR ps.id = t.payment_session_id
WHERE COALESCE(t.no_show_charge_pence, 0) > 0 OR COALESCE(t.cancellation_fee_pence, 0) > 0
  AND COALESCE(ps.captured_amount_pence, 0) > 0
  AND ps.fee_status::text = 'ACTUAL'
  AND NOT EXISTS (
    SELECT 1 FROM driver_wallet_ledger l
    WHERE l.related_trip_id = t.id AND upper(btrim(l.type)) IN ('TRIP_EARNING_NET', 'DRIVER_COMPENSATION_CREDIT') AND l.amount_pence > 0
  )
LIMIT 20;

-- 9) DRIVER_COLLECTED trip with platform wallet credit
SELECT 'dc_trip_platform_wallet' AS check_id, t.trip_code, t.financial_model, l.type, l.amount_pence
FROM trips t
JOIN driver_wallet_ledger l ON l.related_trip_id = t.id AND l.amount_pence > 0
WHERE t.financial_model::text = 'DRIVER_COLLECTED_COMMISSION_WALLET'
  AND upper(btrim(l.type)) IN ('TRIP_EARNING_NET', 'DRIVER_COMPENSATION_CREDIT', 'DRIVER_TIP_CREDIT')
LIMIT 20;

-- 10) PLATFORM trip with commission wallet trip ledger
SELECT 'platform_commission_wallet' AS check_id, t.trip_code, t.financial_model, cwl.id AS cw_ledger_id
FROM trips t
JOIN driver_commission_wallet_ledger cwl ON cwl.trip_id = t.id
WHERE t.financial_model::text = 'PLATFORM_COLLECTED'
LIMIT 20;

-- 11) financial_model null/unknown
SELECT 'financial_model_dist' AS check_id,
  COUNT(*) FILTER (WHERE financial_model::text = 'PLATFORM_COLLECTED') AS platform,
  COUNT(*) FILTER (WHERE financial_model::text = 'DRIVER_COLLECTED_COMMISSION_WALLET') AS driver_collected,
  COUNT(*) FILTER (WHERE financial_model IS NULL) AS null_model,
  COUNT(*) FILTER (WHERE financial_model IS NOT NULL AND financial_model::text NOT IN ('PLATFORM_COLLECTED','DRIVER_COLLECTED_COMMISSION_WALLET')) AS unknown
FROM trips;

SELECT 'null_financial_model_trips' AS check_id, trip_code, id, status, created_at
FROM trips WHERE financial_model IS NULL
ORDER BY created_at DESC LIMIT 10;

-- 12) public financial table RLS disabled
SELECT 'rls_disabled' AS check_id, c.relname AS table_name
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND c.relname IN (
    'payment_sessions', 'driver_wallet_ledger', 'payout_items', 'payout_batches',
    'commission_wallet_ledger', 'driver_payout_reservations', 'payout_item_ledger_allocations'
  )
  AND NOT c.relrowsecurity
ORDER BY 1;

-- 13) captured_at restamp suspect affecting active pending
SELECT 'restamp_affecting_pending' AS check_id, t.trip_code, ps.captured_at, t.completed_at, l.created_at AS ledger_created,
       public.driver_wallet_captured_at_restamp_suspect(ps.captured_at, t.completed_at, l.created_at) AS restamp_suspect,
       b.pending_balance_pence
FROM trips t
JOIN driver_wallet_ledger l ON l.related_trip_id = t.id AND upper(btrim(l.type)) = 'TRIP_EARNING_NET' AND l.amount_pence > 0
JOIN drivers d ON d.id = l.driver_id
CROSS JOIN LATERAL driver_wallet_eligibility_balances(d.id) b
LEFT JOIN LATERAL (
  SELECT s.* FROM payment_sessions s WHERE s.trip_id = t.id OR s.id = t.payment_session_id
  ORDER BY COALESCE(s.captured_amount_pence,0) DESC, s.captured_at DESC NULLS LAST LIMIT 1
) ps ON true
WHERE public.driver_wallet_captured_at_restamp_suspect(ps.captured_at, t.completed_at, l.created_at) = true
  AND b.pending_balance_pence > 0
LIMIT 20;

-- === E. Payout batch 09ad76a2 ===
SELECT 'batch_09ad76a2' AS check_id, pb.id, pb.status, pb.kind, pb.schedule_occurrence_key, pb.completed_at
FROM payout_batches pb WHERE pb.id::text LIKE '09ad76a2%';

SELECT 'batch_items_mk' AS check_id, pi.id, dr.driver_code, pi.status, pi.net_driver_payout_pence, pi.provider_reference,
       (SELECT r.status FROM driver_payout_reservations r WHERE r.payout_item_id = pi.id ORDER BY r.created_at DESC LIMIT 1) AS res_status
FROM payout_items pi
JOIN drivers dr ON dr.id = pi.driver_id
WHERE pi.batch_id::text LIKE '09ad76a2%'
ORDER BY dr.driver_code;

-- MK0001/MK0002 completed payouts
SELECT 'mk_driver_payouts' AS check_id, dr.driver_code, pi.id, pi.status, pi.net_driver_payout_pence, pi.completed_at, pi.provider_reference
FROM payout_items pi
JOIN drivers dr ON dr.id = pi.driver_id
WHERE dr.driver_code IN ('MK0001', 'MK0002')
  AND lower(btrim(COALESCE(pi.status,''))) IN ('completed','paid')
ORDER BY pi.completed_at DESC;

-- === B. Payment sessions totals reconcile ===
SELECT 'ps_totals' AS check_id,
  COALESCE(SUM(captured_amount_pence),0) AS captured_sum,
  COALESCE(SUM(released_amount_pence),0) AS released_sum,
  COALESCE(SUM(refunded_amount_pence),0) AS refunded_sum,
  COALESCE(SUM(provider_processing_fee_pence),0) AS provider_fee_sum,
  COUNT(*) AS session_count
FROM payment_sessions ps
JOIN trips t ON t.id = ps.trip_id
WHERE t.financial_model::text = 'PLATFORM_COLLECTED' OR t.financial_model IS NULL;

SELECT 'ps_driver_collected_rows' AS check_id, COUNT(*) AS cnt
FROM payment_sessions ps
JOIN trips t ON t.id = ps.trip_id
WHERE t.financial_model::text = 'DRIVER_COLLECTED_COMMISSION_WALLET';

-- === D. Driver wallet invariant MK0001/MK0002 ===
SELECT 'mk_wallet_invariant' AS check_id, d.driver_code,
  b.live_balance_pence, b.available_balance_pence, b.pending_balance_pence, b.eligible_earnings_pence,
  (b.available_balance_pence + b.pending_balance_pence <= GREATEST(0, b.live_balance_pence)) AS invariant_ok
FROM drivers d
CROSS JOIN LATERAL driver_wallet_eligibility_balances(d.id) b
WHERE d.driver_code IN ('MK0001','MK0002');

-- Terminal fee 400/24=376 check
SELECT 'terminal_376' AS check_id, t.trip_code, ps.captured_amount_pence, ps.provider_processing_fee_pence,
       l.amount_pence AS wallet_credit
FROM trips t
JOIN payment_sessions ps ON ps.trip_id = t.id
JOIN driver_wallet_ledger l ON l.related_trip_id = t.id AND upper(btrim(l.type)) = 'TRIP_EARNING_NET'
WHERE COALESCE(t.no_show_charge_pence,0) = 400
  AND COALESCE(ps.captured_amount_pence,0) = 400
ORDER BY t.completed_at DESC NULLS LAST
LIMIT 10;

-- === H. Owner approval ===
SELECT 'owner_admin' AS check_id, u.email, sp.role, sp.is_owner, sp.is_active
FROM staff_profiles sp
JOIN auth.users u ON u.id = sp.user_id
WHERE u.email = 'admin@onecab.net' OR sp.is_owner = true;

-- === F. Company funds (if views exist) ===
SELECT 'company_reserve_config' AS check_id, id, status, reserve_mode, reserve_amount_pence, reserve_percentage_bps, activated_at
FROM company_operational_refund_reserves
ORDER BY updated_at DESC NULLS LAST
LIMIT 5;

-- Protected liabilities snapshot (function if exists)
SELECT 'protected_liabilities_fn' AS check_id,
  CASE WHEN EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'protected_driver_liabilities_total_pence'
  ) THEN 'exists' ELSE 'missing' END AS fn_status;
