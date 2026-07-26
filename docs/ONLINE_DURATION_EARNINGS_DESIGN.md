# Online duration in Earnings SSOT — design proposal (Gap 4)

**Status:** NOT production-reliable — do **not** expose a fabricated metric on Driver Earnings.

## Audit summary

| Candidate source | Assessment |
|------------------|------------|
| `drivers.is_online` / `online_since` | Point-in-time only; `online_since` not consistently assigned in repo SQL |
| `driver_presence` | Current heartbeat row per driver; overwritten — **no history** |
| Wallet / `get_driver_own_wallet_summary` / `driver_wallet_summary_ssot` | No online-duration fields |
| Trip lifecycle | Measures trip time, not online availability |
| `driver_commitment_sessions` | Pickup commitment, not online sessions |

**Conclusion:** There is no append-only online/offline session ledger. Period online duration cannot be computed authoritatively from existing data.

## Recommended future SSOT (do not implement until approved)

1. Table `driver_online_sessions`  
   - `id`, `driver_id`, `service_area_id`, `started_at`, `ended_at`, `end_reason` (`explicit_offline` \| `stale_reconcile` \| `crash_inferred`), `source`
2. Write path: go-online / go-offline / `reconcile_stale_online_drivers` close open sessions
3. Overlap prevention: one open session per driver (partial unique index where `ended_at IS NULL`)
4. Earnings RPC extension only after backfill policy:  
   - `online_seconds`  
   - `online_duration_source = 'driver_online_sessions'`  
   - `online_duration_complete = false` when history incomplete for range

## Interim API rule

Keep `get_driver_own_wallet_summary` unchanged.  
If a client asks for online duration before the session ledger exists, return `null` / omit — never invent from `is_online`.
