# Ops Detector SSOT Alignment Migration

**Migration file:** `supabase/migrations/20260827120000_ops_detector_ssot_alignment.sql`  
**Validation script:** `scripts/ops-detector-ssot-validation.sql`  
**Status:** Prepared — **do not deploy to production until diff and validation output are reviewed**

## Purpose

Align Ops Intelligence detectors with **Financial Reconciliation SSOT** and stop synthetic/demo seed data from creating production-critical alerts.

This migration:
- Updates detector function definitions (read-only logic)
- Deletes synthetic `ops_logs` rows
- Resolves phantom/demo alerts and FR-verified false positives

This migration **does not**:
- Auto-create ledger entries
- Modify `payments`, `driver_wallet_ledger`, wallet balances, commission, captures, refunds, or payouts

---

## Detectors changed

| Function | Change |
|----------|--------|
| `ops_detect_error_spikes()` | Added `AND is_synthetic = false` |
| `ops_detect_5xx_spikes()` | Added `AND is_synthetic = false` |
| `ops_detect_latency_spikes()` | Added `AND is_synthetic = false` |
| `ops_detect_edge_function_failures()` | Added `AND is_synthetic = false` |
| `ops_detect_webhook_failures()` | Added `AND is_synthetic = false` |
| `ops_detect_missing_earnings()` | Rewritten — wallet ledger SSOT |
| `ops_detect_missing_commissions()` | Rewritten — payments + wallet SSOT |

**Already filtered (unchanged):** `ops_detect_log_anomalies()`, `ops_detect_fatal_logs()` — these already had `is_synthetic = false` from migration `20260401113606`.

**Out of scope (follow-up):** `ops_detect_commission_gaps()`, `ops_detect_earning_gaps()`, `ops_detect_payment_gaps()` still reference deprecated `trip_finance` — separate migration recommended.

---

## Deprecated sources removed

| Detector | Old (deprecated) | New (FR SSOT) |
|----------|------------------|---------------|
| `ops_detect_missing_earnings` | `driver_ledger` (`TRIP_EARNING_NET`, `CASH_COMMISSION_DEBT`) | `driver_wallet_ledger` with cash/card type split |
| `ops_detect_missing_commissions` | `trip_finance.platform_commission_pence` | `payments.commission_amount_pence` (card) + `driver_wallet_ledger` (`CASH_COMMISSION_DEBT`, `PLATFORM_COMMISSION`, `COMPANY_COMMISSION`) |

### New SSOT logic summary

**Missing earnings** (`ops_detect_missing_earnings`):
- **Cash:** alert if no `driver_wallet_ledger` row with type `CASH_COMMISSION_DEBT` or `CASH_TRIP_EARNING`
- **Card:** alert only after capture settled (`payments.status IN ('captured','succeeded')`) or 30-minute grace window, and no `TRIP_EARNING_NET` in wallet ledger

**Missing commission** (`ops_detect_missing_commissions`):
- **Cash:** satisfied by wallet commission types (`CASH_COMMISSION_DEBT`, `PLATFORM_COMMISSION`, `COMPANY_COMMISSION`)
- **Card:** satisfied by `payments` row with `commission_amount_pence > 0`, or wallet `PLATFORM_COMMISSION` / `COMPANY_COMMISSION`

Cash and card ledgers remain **separate** — detection respects `trips.payment_method`.

---

## Synthetic-log filter

All five log-based spike detectors now include:

```sql
AND is_synthetic = false
```

**Data cleanup (section 3 of migration):**
1. `DELETE FROM ops_logs WHERE is_synthetic = true`
2. Resolve `ops_alerts` where `fingerprint LIKE 'demo:%'`
3. Resolve spike alerts with `related_trip_id IS NULL` and fingerprints:
   - `error_spike:%`, `5xx_spike:%`, `latency_spike:%`
   - `edge_fn_failure:%`, `webhook_failure:%`, `fatal_log:%`

Metadata tags: `resolved_reason = 'ops_detector_ssot_alignment'`, `suppression = 'demo_seed'` or `'synthetic_log_spike'`.

---

## MK-260625-001 false positive resolution

Trip `c9aeea66-f511-47f9-97aa-15eda198a876` — FR validation **before migration** (prod read-only):

| Check | Result |
|-------|--------|
| Trip completed | `status = completed`, `2026-06-25 11:59:49 UTC` |
| Payment captured | `payments.status = captured`, £4.80 |
| Commission recorded | `commission_amount_pence = 72` (15%) |
| Driver net in wallet | `TRIP_EARNING_NET +408p` |
| Missing money | **No** |

Migration resolves open `earning` + `commission` alerts and unresolved `ops_events` for this trip with:

```json
{
  "false_positive": true,
  "resolved_reason": "fr_ssot_verified",
  "trip_code": "MK-260625-001"
}
```

**No ledger or payment writes.**

---

## Before / after alert counts (prod snapshot)

Captured via `supabase db query --linked` on **2026-06-25** before migration apply.

| Metric | Before | After (projected) |
|--------|--------|-------------------|
| Open alerts (total) | 48 | 5 |
| Open demo alerts (`demo:%`) | 30 | 0 |
| Open real alerts | 18 | 5 |
| Backend spike alerts | 13 | 0 |
| Open earning alerts | 2 | 0 |
| Open commission alerts | 2 | 0 |
| Synthetic `ops_logs` | 27 | 0 |

**Alerts remaining open after migration (5):** legitimate workflow/info items — driver self sign-out (×2), call masking deploy ping, driver accept smoke test, admin panel slow `drivers` screen. None are finance or synthetic spike alerts.

**Alerts resolved by migration (43):** 30 demo + 11 synthetic spike + 2 MK-260625-001 finance false positives.

**Not addressed in this migration:** 327 unresolved historical `earning_missing` and 323 `commission_missing` `ops_events` from the old detector — bulk reconcile in a follow-up (read-only audit against wallet ledger, no auto-repair).

---

## Validation queries

Run `scripts/ops-detector-ssot-validation.sql` against linked prod **before** and **after** apply.

### Pre-apply checklist

```bash
cd onecab-comfy-ride   # or admin-new
npx supabase db query --file scripts/ops-detector-ssot-validation.sql --linked
```

Expected **before** apply:
- Section A: counts match table above
- Section B: MK-260625-001 shows captured payment + `TRIP_EARNING_NET` 408p
- Section C–D: **0 rows** (no real SSOT gaps in last 24h)
- Section E: synthetic log rows present
- Section F: may show spike groups if synthetic logs still within time windows
- Section G: lists 43 alerts to be resolved

### Post-apply checklist

```bash
npx supabase db query --file scripts/ops-detector-ssot-validation.sql --linked
npx supabase db query "SELECT ops_run_all_detections();" --linked
# Re-run validation — spike detectors must not recreate phantom alerts
```

Expected **after** apply:
- Section A: `open_alerts_total = 5`, `synthetic_logs = 0`, `open_backend_spike = 0`
- Section E: **0 rows**
- Section F: **0 rows** (no non-synthetic spike groups)
- Post `ops_run_all_detections()`: no new spike or MK finance alerts

### FR integrity guard (must not change)

```sql
-- Row counts on finance tables must be identical before/after
SELECT count(*) FROM payments;
SELECT count(*) FROM driver_wallet_ledger;
SELECT sum(amount_pence) FROM driver_wallet_ledger;
```

---

## Rollback plan

### 1. Restore detector functions

Re-apply prior definitions from:
- Log spikes: `supabase/migrations/20260331053245_032ec3e4-31aa-45c6-945f-b96864f7c568.sql`
- Finance detectors: `supabase/migrations/20260331050856_f9c4ec83-fa49-4a1e-9ecc-330c58a076e2.sql`

Or create reverse migration `20260827120001_ops_detector_ssot_alignment_rollback.sql` with those `CREATE OR REPLACE FUNCTION` bodies.

### 2. Alert / log data

- **Synthetic logs:** deleted rows cannot be restored unless re-seeded via admin `ops-seed` edge function (admin-only).
- **Resolved alerts:** revert with:

```sql
UPDATE ops_alerts
SET status = 'open', resolved_at = NULL
WHERE metadata->>'resolved_reason' = 'ops_detector_ssot_alignment'
   OR metadata->>'resolved_reason' = 'fr_ssot_verified';
```

- **MK ops_events:** revert false-positive resolution if needed:

```sql
UPDATE ops_events
SET resolved = false, resolved_at = NULL
WHERE metadata->>'resolved_reason' = 'fr_ssot_verified'
  AND trip_id = 'c9aeea66-f511-47f9-97aa-15eda198a876';
```

### 3. Finance data

No rollback needed — migration does not touch money tables.

---

## Deploy procedure (after review)

1. Review migration diff in both repos:
   - `admin-new/supabase/migrations/20260827120000_ops_detector_ssot_alignment.sql`
   - `onecab-comfy-ride/supabase/migrations/20260827120000_ops_detector_ssot_alignment.sql`
2. Run pre-apply validation script; attach output to PR
3. Apply to staging first (if available), then prod:

```bash
npx supabase db push --linked
```

4. Run post-apply validation + `ops_run_all_detections()`
5. Confirm Ops Intelligence UI shows ~5 open non-critical alerts, no finance P0s

---

## Files added

| Path | Description |
|------|-------------|
| `admin-new/supabase/migrations/20260827120000_ops_detector_ssot_alignment.sql` | Migration (canonical) |
| `onecab-comfy-ride/supabase/migrations/20260827120000_ops_detector_ssot_alignment.sql` | Migration (customer repo parity) |
| `admin-new/scripts/ops-detector-ssot-validation.sql` | Read-only validation queries |
| `admin-new/docs/OPS_DETECTOR_SSOT_ALIGNMENT_MIGRATION.md` | This document |

---

## Review sign-off

- [ ] Migration diff reviewed
- [ ] Pre-apply validation output attached
- [ ] FR integrity queries confirmed no money-table writes in migration
- [ ] Post-apply validation planned
- [ ] Approved for prod deploy
