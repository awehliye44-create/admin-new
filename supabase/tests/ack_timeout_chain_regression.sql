-- Regression fixture (anonymised) for instant-dispatch ack-timeout → redispatch.
-- Pattern from production MK-260803-009 (paid instant; wave1 unacked; BOOT_ERROR on redispatch).
-- Run manually against a non-production clone OR as documentation of expected SQL behaviour.
-- Does NOT mutate production.

-- Expectations encoded as comments for operators:
-- 1) process_ride_offer_ack_timeouts MUST NOT expire when expires_at > now()
-- 2) MUST expire pending + ack_at IS NULL when expires_at <= now()
-- 3) MUST NOT expire when ack_at IS NOT NULL
-- 4) MUST NOT expire when status = 'accepted'
-- 5) Second call is idempotent (0 rows)
-- 6) Redispatch is owned by Edge ack-timeout-sweep (no net.http_post in SQL)

SELECT 'ack_timeout_chain_regression_doc_ok' AS status;
