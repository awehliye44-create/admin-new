-- Controlled deploy post-verification (read-only, no mutations)

-- 1) MK driver eligibility balances
SELECT 'mk_eligibility' AS section, row_to_json(x.*) AS payload
FROM (
  SELECT d.driver_code, d.id AS driver_id,
         b.live_balance_pence, b.available_balance_pence, b.pending_balance_pence,
         b.eligible_earnings_pence, b.withdrawal_in_progress_pence, b.outstanding_debt_pence
  FROM drivers d
  CROSS JOIN LATERAL driver_wallet_eligibility_balances(d.id) b
  WHERE d.driver_code IN ('MK0001', 'MK0002')
  ORDER BY d.driver_code
) x

UNION ALL

-- 2) Audit trips: restamp, stable origin, unpaid remainder, would-be pending
SELECT 'audit_trips' AS section, row_to_json(x.*) AS payload
FROM (
  SELECT t.trip_code,
         ps.captured_at,
         t.completed_at,
         l.created_at AS ledger_created_at,
         l.amount_pence AS ledger_amount,
         public.driver_wallet_captured_at_restamp_suspect(ps.captured_at, t.completed_at, l.created_at) AS restamp_suspect,
         public.driver_wallet_stable_clearing_origin(ps.captured_at, t.completed_at, des.capture_time, l.created_at, NULL) AS stable_origin,
         COALESCE(alloc.active_alloc_sum, 0)::bigint AS active_alloc_sum,
         GREATEST(0, l.amount_pence - COALESCE(alloc.active_alloc_sum, 0))::bigint AS unpaid_remainder,
         des.paid_in_payout_item_id IS NOT NULL AS paid_out_flag,
         (
           public.driver_wallet_stable_clearing_origin(ps.captured_at, t.completed_at, des.capture_time, l.created_at, NULL)
           + (public.driver_wallet_payout_clearing_delay_hours() * interval '1 hour')
         ) > now() AS within_27h_window,
         CASE
           WHEN GREATEST(0, l.amount_pence - COALESCE(alloc.active_alloc_sum, 0)) <= 0 THEN false
           WHEN des.paid_in_payout_item_id IS NOT NULL OR des.allocated_to_payout IS TRUE THEN false
           WHEN (
             public.driver_wallet_stable_clearing_origin(ps.captured_at, t.completed_at, des.capture_time, l.created_at, NULL)
             + (public.driver_wallet_payout_clearing_delay_hours() * interval '1 hour')
           ) > now() THEN true
           ELSE false
         END AS counts_as_pending_now
  FROM trips t
  JOIN driver_wallet_ledger l ON l.related_trip_id = t.id AND l.type = 'TRIP_EARNING_NET' AND l.amount_pence > 0
  LEFT JOIN LATERAL (
    SELECT s.* FROM payment_sessions s
    WHERE s.id = t.payment_session_id OR s.trip_id = t.id
    ORDER BY COALESCE(s.captured_amount_pence, 0) DESC, s.captured_at DESC NULLS LAST LIMIT 1
  ) ps ON true
  LEFT JOIN LATERAL (
    SELECT d.* FROM driver_earning_settlement d WHERE d.ledger_entry_id = l.id
    ORDER BY d.updated_at DESC NULLS LAST LIMIT 1
  ) des ON true
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(a.amount_pence), 0) AS active_alloc_sum
    FROM payout_item_ledger_allocations a
    JOIN payout_items pi ON pi.id = a.payout_item_id
    WHERE a.ledger_entry_id = l.id
      AND NOT public.payout_item_status_releases_ledger_allocation(pi.status, pi.execution_status)
  ) alloc ON true
  WHERE t.trip_code IN ('MK-260815-028', 'MK-260815-010', 'MK-260813-002', 'MK-260810-011')
  ORDER BY t.trip_code
) x

UNION ALL

-- 3) Invariant: available + pending <= live (per driver)
SELECT 'live_invariant' AS section, row_to_json(x.*) AS payload
FROM (
  SELECT d.driver_code,
         b.live_balance_pence,
         b.available_balance_pence,
         b.pending_balance_pence,
         b.eligible_earnings_pence,
         (b.available_balance_pence + b.pending_balance_pence <= GREATEST(0, b.live_balance_pence)) AS invariant_ok,
         (b.available_balance_pence + b.pending_balance_pence <= b.eligible_earnings_pence + b.pending_balance_pence) AS eligible_stack_ok
  FROM drivers d
  CROSS JOIN LATERAL driver_wallet_eligibility_balances(d.id) b
  WHERE d.driver_code IN ('MK0001', 'MK0002')
) x

UNION ALL

-- 4) Genuine recent capture under 27h (logic proof + any live rows)
SELECT 'recent_pending_logic' AS section, row_to_json(x.*) AS payload
FROM (
  SELECT public.driver_wallet_payout_clearing_delay_hours() AS delay_hours,
         (timestamptz '2026-09-01 10:00:00+00' + (public.driver_wallet_payout_clearing_delay_hours() * interval '1 hour') > now()) AS sim_15h_ago_still_pending,
         (timestamptz '2026-08-15 10:26:11+00' + (public.driver_wallet_payout_clearing_delay_hours() * interval '1 hour') > now()) AS mk260815010_still_pending
) x

UNION ALL

-- 5) Paid-out rows must not be active liabilities
SELECT 'paid_out_exclusion' AS section, row_to_json(x.*) AS payload
FROM (
  SELECT t.trip_code, pi.status AS payout_status, a.amount_pence AS alloc_pence,
         des.paid_in_payout_item_id IS NOT NULL AS des_paid
  FROM trips t
  JOIN driver_wallet_ledger l ON l.related_trip_id = t.id AND l.type = 'TRIP_EARNING_NET'
  LEFT JOIN payout_item_ledger_allocations a ON a.ledger_entry_id = l.id
  LEFT JOIN payout_items pi ON pi.id = a.payout_item_id
  LEFT JOIN driver_earning_settlement des ON des.ledger_entry_id = l.id
  WHERE t.trip_code = 'MK-260815-028'
    AND (a.id IS NOT NULL OR des.paid_in_payout_item_id IS NOT NULL)
) x

UNION ALL

-- 6) Company funds snapshot (Revolut + protected sum from MK platform drivers pending)
SELECT 'company_funds' AS section, row_to_json(x.*) AS payload
FROM (
  SELECT
    (SELECT COALESCE(SUM(b.pending_balance_pence), 0) FROM drivers d
     CROSS JOIN LATERAL driver_wallet_eligibility_balances(d.id) b
     WHERE d.id IN (SELECT id FROM drivers WHERE driver_code IN ('MK0001','MK0002'))) AS mk_pending_total,
    (SELECT COUNT(*) FROM drivers d
     CROSS JOIN LATERAL driver_wallet_eligibility_balances(d.id) b
     WHERE b.pending_balance_pence > 0) AS drivers_with_pending_globally
) x

UNION ALL

-- 7) Historical session for edge verification baseline
SELECT 'edge_baseline' AS section, row_to_json(x.*) AS payload
FROM (
  SELECT ps.id AS session_id, t.trip_code, ps.captured_at, ps.captured_amount_pence,
         ps.provider_state_verified_at, ps.provider_state
  FROM payment_sessions ps
  JOIN trips t ON t.id = ps.trip_id
  WHERE t.trip_code = 'MK-260815-010'
  ORDER BY ps.captured_at DESC NULLS LAST
  LIMIT 1
) x;
