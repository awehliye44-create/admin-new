-- Rollback #89A claim_payment_session_tripless_release release_pending fix.
-- Restores prior CHECK-violating 'releasing' claim marker ONLY if explicitly required.
-- Prefer keeping release_pending; this file documents the reverse for ops.

-- No-op restore intentionally omitted: reintroducing 'releasing' breaks the CHECK
-- constraint payment_sessions_hold_release_state_check. Leave function as
-- release_pending (forward-only safety).

SELECT 1;
