-- Read-only post-migration verification: captured_at restamp guard

WITH mk_drivers AS (
  SELECT id, driver_code
  FROM drivers
  WHERE driver_code IN ('MK0001', 'MK0002')
),
mk_balances AS (
  SELECT
    d.driver_code,
    b.live_balance_pence,
    b.available_balance_pence,
    b.pending_balance_pence,
    b.eligible_earnings_pence,
    b.withdrawal_in_progress_pence,
    b.outstanding_debt_pence
  FROM mk_drivers d
  CROSS JOIN LATERAL driver_wallet_eligibility_balances(d.id) b
),
audit_trips AS (
  SELECT
    t.trip_code,
    t.id AS trip_id,
    t.driver_id,
    t.completed_at,
    l.id AS ledger_id,
    l.amount_pence AS ledger_amount,
    ps.captured_at,
    ps.captured_amount_pence,
    public.driver_wallet_captured_at_restamp_suspect(
      ps.captured_at,
      t.completed_at,
      l.created_at
    ) AS restamp_suspect,
    public.driver_wallet_stable_clearing_origin(
      ps.captured_at,
      t.completed_at,
      des.capture_time,
      l.created_at,
      CASE
        WHEN ps.metadata IS NOT NULL
             AND jsonb_typeof(ps.metadata) = 'object'
             AND NULLIF(btrim(ps.metadata->>'first_captured_at'), '') IS NOT NULL
        THEN (ps.metadata->>'first_captured_at')::timestamptz
        ELSE NULL
      END
    ) AS stable_clearing_origin,
    COALESCE(alloc.active_alloc_sum, 0)::bigint AS active_alloc_sum,
    GREATEST(0, l.amount_pence - COALESCE(alloc.active_alloc_sum, 0))::bigint AS unpaid_remainder,
    des.paid_in_payout_item_id IS NOT NULL AS des_paid_out,
    des.allocated_to_payout AS des_allocated_flag
  FROM trips t
  INNER JOIN driver_wallet_ledger l
    ON l.related_trip_id = t.id
   AND l.type = 'TRIP_EARNING_NET'
   AND l.amount_pence > 0
  LEFT JOIN LATERAL (
    SELECT s.*
    FROM payment_sessions s
    WHERE s.id = t.payment_session_id OR s.trip_id = t.id
    ORDER BY COALESCE(s.captured_amount_pence, 0) DESC, s.captured_at DESC NULLS LAST
    LIMIT 1
  ) ps ON true
  LEFT JOIN LATERAL (
    SELECT d.*
    FROM driver_earning_settlement d
    WHERE d.ledger_entry_id = l.id
    ORDER BY d.updated_at DESC NULLS LAST
    LIMIT 1
  ) des ON true
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(a.amount_pence), 0) AS active_alloc_sum
    FROM payout_item_ledger_allocations a
    INNER JOIN payout_items pi ON pi.id = a.payout_item_id
    WHERE a.ledger_entry_id = l.id
      AND NOT public.payout_item_status_releases_ledger_allocation(pi.status, pi.execution_status)
  ) alloc ON true
  WHERE t.trip_code IN (
    'MK-260815-028',
    'MK-260815-010',
    'MK-260813-002',
    'MK-260810-011'
  )
),
recent_pending AS (
  SELECT
    t.trip_code,
    t.completed_at,
    l.amount_pence,
    ps.captured_at,
    public.driver_wallet_stable_clearing_origin(
      ps.captured_at,
      t.completed_at,
      des.capture_time,
      l.created_at,
      NULL
    ) AS stable_clearing_origin,
    (
      public.driver_wallet_stable_clearing_origin(
        ps.captured_at,
        t.completed_at,
        des.capture_time,
        l.created_at,
        NULL
      ) + (public.driver_wallet_payout_clearing_delay_hours() * interval '1 hour')
    ) > now() AS still_within_27h_window
  FROM trips t
  INNER JOIN driver_wallet_ledger l
    ON l.related_trip_id = t.id
   AND l.type = 'TRIP_EARNING_NET'
   AND l.amount_pence > 0
  INNER JOIN mk_drivers d ON d.id = t.driver_id
  LEFT JOIN LATERAL (
    SELECT s.*
    FROM payment_sessions s
    WHERE s.id = t.payment_session_id OR s.trip_id = t.id
    ORDER BY COALESCE(s.captured_amount_pence, 0) DESC, s.captured_at DESC NULLS LAST
    LIMIT 1
  ) ps ON true
  LEFT JOIN LATERAL (
    SELECT des.capture_time
    FROM driver_earning_settlement des
    WHERE des.ledger_entry_id = l.id
    ORDER BY des.updated_at DESC NULLS LAST
    LIMIT 1
  ) des ON true
  WHERE t.completed_at > now() - interval '24 hours'
    AND ps.captured_amount_pence > 0
  ORDER BY t.completed_at DESC
  LIMIT 5
)
SELECT 'mk_balances' AS section, row_to_json(mk_balances.*) AS payload FROM mk_balances
UNION ALL
SELECT 'audit_trips' AS section, row_to_json(audit_trips.*) AS payload FROM audit_trips
UNION ALL
SELECT 'recent_pending' AS section, row_to_json(recent_pending.*) AS payload FROM recent_pending;
