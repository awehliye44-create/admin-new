# Online duration in Earnings SSOT — design proposal (Gap 4)

**Status:** NOT production-reliable — do **not** expose a fabricated metric on Driver Earnings.

## Audit summary

| Candidate source | Assessment |
|------------------|------------|
| `drivers.is_online` / `online_since` | Point-in-time only |
| `driver_presence` | Current heartbeat; no history |
| Wallet / `get_driver_own_wallet_summary` | No online-duration fields |
| Trip lifecycle | Trip time ≠ online availability |

**Conclusion:** No append-only online/offline session ledger. Period online duration cannot be computed authoritatively.

## Recommended future SSOT (do not implement until approved)

1. Table `driver_online_sessions` with start/end, end_reason, overlap prevention
2. Wire go-online / go-offline / stale reconcile
3. Extend earnings RPC only after backfill policy with `online_seconds`, `online_duration_source`, `online_duration_complete`

## Interim API rule

Keep `get_driver_own_wallet_summary` unchanged. Never invent from `is_online`.
