-- Read-only FR deployment fingerprint (MK0001 / MK0002)
WITH drivers AS (
  SELECT id, driver_code FROM drivers WHERE driver_code IN ('MK0001', 'MK0002')
),
wallet AS (
  SELECT d.driver_code,
         COUNT(*) AS ledger_rows,
         COALESCE(SUM(CASE WHEN l.type IN ('TRIP_EARNING_NET','TRIP_SETTLEMENT_CORRECTION','SETTLEMENT_CORRECTION') THEN l.amount_pence ELSE 0 END), 0) AS trip_credit_sum_pence,
         COALESCE(SUM(l.amount_pence), 0) AS balance_sum_pence
  FROM driver_wallet_ledger l
  JOIN drivers d ON d.id = l.driver_id
  GROUP BY d.driver_code
),
payout AS (
  SELECT d.driver_code,
         COALESCE(SUM(CASE WHEN pi.status IN ('completed','paid') THEN COALESCE(pi.net_driver_payout_pence, pi.amount_pence, 0) ELSE 0 END), 0) AS completed_payout_pence
  FROM payout_items pi
  JOIN drivers d ON d.id = pi.driver_id
  GROUP BY d.driver_code
),
reservations AS (
  SELECT d.driver_code, COUNT(*) AS active_reservations
  FROM driver_payout_reservations pr
  JOIN drivers d ON d.id = pr.driver_id
  WHERE pr.status IN ('active','pending','processing')
  GROUP BY d.driver_code
),
stamps AS (
  SELECT d.driver_code,
         COUNT(DISTINCT t.id) AS trip_count,
         COUNT(DISTINCT des.trip_id) AS settlement_stamp_count
  FROM drivers d
  LEFT JOIN trips t ON t.driver_id = d.id AND t.financial_model = 'PLATFORM_COLLECTED'
  LEFT JOIN driver_earning_settlement des ON des.trip_id = t.id
  GROUP BY d.driver_code
)
SELECT d.driver_code,
       w.ledger_rows,
       w.trip_credit_sum_pence,
       w.balance_sum_pence,
       p.completed_payout_pence,
       COALESCE(r.active_reservations, 0) AS active_reservations,
       s.trip_count,
       s.settlement_stamp_count
FROM drivers d
LEFT JOIN wallet w ON w.driver_code = d.driver_code
LEFT JOIN payout p ON p.driver_code = d.driver_code
LEFT JOIN reservations r ON r.driver_code = d.driver_code
LEFT JOIN stamps s ON s.driver_code = d.driver_code
ORDER BY d.driver_code;
