# Phase 3C.5 — Historical Stripe Payout Remediation Audit

**Date:** 2026-06-18  
**Status:** Read-only audit — **no DB writes, no Stripe actions**  
**Project:** `thazislrdkjpvvghtvzo` (ONECAB prod)  
**Stripe enumeration:** 2026-01-01 → 2026-06-18 (platform launch 2026-01-08)  
**Method:** Live Stripe API (`stripe-reconciliation-audit`) + prod DB (service role)

---

## Executive summary

| Metric | Value |
|--------|------:|
| **Driver Connect payouts (paid)** on current accounts | **£77.91** (7,791p) |
| **Ledger payout debits** (surviving DB) | **£4.57** (457p) |
| **Unreconciled gap** | **£73.34** (7,334p) |
| **Orphan Stripe payouts without ledger** | **2** (auto sweeps) |
| **Partially reconciled** | **1** (`po_1Tjb00…` — ledger yes, `payout_item` broken) |
| **Unmatched bank credit** | **£9.43** |

**GO / NO-GO for finance correction deployment:** **NO-GO** until Ahmed/finance sign-off on MK0002 wallet impact (full debit may drive wallet **negative**) and £9.43 is matched or explicitly excluded.

---

## 1. Stripe payout enumeration (since platform launch)

### 1.1 Platform account (ONECAB Ltd → corporate bank)

Not driver liabilities — listed for completeness only. **No** `driver_wallet_ledger` remediation.

| Stripe payout ID | Amount | Status | Created (UTC) |
|------------------|-------:|--------|---------------|
| `po_1TiO2IEeK1Cb9ZBxM42lTU2Q` | £13.36 | paid | 2026-06-15 |
| `po_1TgZwZEeK1Cb9ZBx3aJ0fUch` | £28.87 | paid | 2026-06-10 |
| `po_1TdK3KEeK1Cb9ZBxoRCajakm` | £9.94 | paid | 2026-06-01 |
| `po_1TYEd8EeK1Cb9ZBxP91Sx5MO` | £7.40 | paid | 2026-05-18 |
| `po_1TTXAZEeK1Cb9ZBxroC6pEvU` | £4.52 | paid | 2026-05-05 |
| `po_1T8ri4EeK1Cb9ZBxC3IpT6ja` | £11.03 | paid | 2026-03-09 |

**Platform total paid:** £75.12 (7,512p)

### 1.2 Connected accounts — current MK drivers

Enumerated on `acct_1ThTrEEXTz9Ab5Ic` (MK0001) and `acct_1ThUR8Izd0dzmC0Y` (MK0002).

| Driver | Stripe payout ID | Amount | Status | Created (UTC) | Engine |
|--------|------------------|-------:|--------|---------------|--------|
| MK0002 Asiya | `po_1TjUCpIzd0dzmC0Y65sJxUHu` | **£56.41** | paid | 2026-06-18 00:53 | Stripe auto sweep |
| MK0001 Ahmed | `po_1TjTPXEXTz9Ab5IcE2GFPiaq` | **£16.93** | paid | 2026-06-18 00:02 | Stripe auto sweep |
| MK0001 Ahmed | `po_1Tjb00EXTz9Ab5IcGLdtDR2s` | **£4.57** | paid | 2026-06-18 08:08 | `admin-driver-payout` |

**Connected total paid (current accounts):** £77.91 (7,791p)

### 1.3 Legacy connected account (pre–12 Jun driver) — **not API-enumerated**

Deleted from `drivers` table on reset/re-provision. Documented in ops reports only:

| Stripe payout ID | Amount | Status (at time of report) | DB today |
|------------------|-------:|----------------------------|----------|
| `po_1TgwCxImYgLhqfX02AUIfT8F` | £41.16 (4116p) | paid | Ledger **deleted** (1 Jun reset) |
| `po_1TffdpImYgLhqfX0coqg8arU` | £7.77 (777p) | pending/paid | Ledger **deleted**; `driver_early_cashouts` empty |

**Legacy total (documented):** £48.93 (4,893p) — requires Stripe Dashboard search on **old** Connect account ID (not on current MK0001 account; `admin-stripe-payout-peek` returns 500).

### 1.4 Transfers (platform → Connect) — context only

| Driver | Transfer count | Sum | Matches bank payout? |
|--------|---------------:|----:|----------------------|
| MK0001 | 7 | 3,104p | Payouts paid 2,150p < transfers |
| MK0002 | 12 | **5,641p** | Payout **5,641p** = transfer sum exactly |

Transfers are trip settlements, **not** wallet debits. Bank payouts must still post ledger debits.

---

## 2. ONECAB match matrix

| Stripe payout | payout_batch | payout_item | Ledger | Type | Match |
|---------------|-------------|-------------|--------|------|-------|
| `po_1TjUCp…` MK0002 £56.41 | ❌ | ❌ | ❌ | — | **ORPHAN** |
| `po_1TjTPX…` MK0001 £16.93 | ❌ | ❌ | ❌ | — | **ORPHAN** |
| `po_1Tjb00…` MK0001 £4.57 | `d627233c` | `2c50b7df` ⚠️ | ✅ `3448df70` | MANUAL_PAYOUT | **PARTIAL** |
| `po_1TgwCx…` £41.16 (legacy) | ❌ (deleted) | ❌ (deleted) | ❌ (deleted) | WEEKLY_PAYOUT (was backfilled) | **LOST** |
| `po_1Tffdp…` £7.77 (legacy) | ❌ | ❌ | ❌ | EARLY_CASHOUT | **LOST** |
| Orphan batches £42.08 ×2 | `99e964b1`, `06b1c321` | ❌ | ❌ | — | **GHOST** (no Stripe payout) |

### 2.1 `payout_items` hygiene issues (non-Stripe)

| Item ID | Issue | Remediation class |
|---------|-------|-------------------|
| `c5bcd2f7-…` | Duplicate £4.57 weekly; no Stripe ids | **Cancel** — no ledger |
| `2c50b7df-…` | `ledger_entry_id` null; `status=pending` despite paid transfer | **Link** to `3448df70` |

### 2.2 Orphan `payout_batches` (£42.08)

| Batch | Amount | Stripe payout | Remediation |
|-------|-------:|---------------|-------------|
| `99e964b1-…` | 4208p | **None** | Archive / leave `INVALID_ORPHANED` — **no ledger entry** |
| `06b1c321-…` | 4208p | **None** | Same |

Amount mirrors pre-reset Ahmed wallet ghost — **not** a bank movement.

---

## 3. Per-driver totals

### 3.1 Current accounts (Stripe API + surviving DB)

| Driver | Paid via Stripe (paid `po_*`) | Debited in ledger | Difference (under-debited) | Wallet SSOT today |
|--------|------------------------------:|------------------:|---------------------------:|------------------:|
| **MK0001** Ahmed | **2,150p** (£21.50) | **457p** (£4.57) | **1,693p** (£16.93) | **1,780p** (£17.80) |
| **MK0002** Asiya | **5,641p** (£56.41) | **0p** | **5,641p** (£56.41) | **1,901p** (£19.01) |
| **Total** | **7,791p** (£77.91) | **457p** (£4.57) | **7,334p** (£73.34) | — |

### 3.2 Legacy (documented, not in current API scan)

| Driver (attribution) | Paid via Stripe (docs) | Debited in ledger | Difference |
|----------------------|-------------------------:|------------------:|-----------:|
| Ahmed (pre-reset `58b29f86-…`) | **4,893p** (£48.93) | **0p** (wiped) | **4,893p** |

### 3.3 Projected wallet after **full** Stripe-matched remediation

| Driver | Wallet today | Proposed additional debits | Projected wallet | Risk |
|--------|-------------:|---------------------------:|-----------------:|------|
| MK0001 | 1,780p | −1,693p (`po_1TjTPX`) | **87p** | Low |
| MK0002 | 1,901p | −5,641p (`po_1TjUCp`) | **−3,740p** | **HIGH** — requires finance decision |

MK0002 negative projection indicates Connect auto-payout swept **more than ledger wallet SSOT** (transfer sum 5,641p vs wallet 1,901p). Remediation must not blindly post −5,641p without reconciling **why** Connect balance exceeded wallet (reversals, timing, or residual Connect balance).

---

## 4. Explainer — flagged bank credits

### 4.1 £56.41 — MK0002 payout

| Field | Value |
|-------|-------|
| Bank evidence | +£56.41, ONECAB LIMITED / Stripe Payments UK (18 Jun) |
| Stripe | `po_1TjUCpIzd0dzmC0Y65sJxUHu`, **5641p**, **paid** |
| Driver | **MK0002** Asiya (`acct_1ThUR8Izd0dzmC0Y`) |
| Mechanism | Automatic Connect standard payout of full transfer balance |
| ONECAB gap | No `payout_item`, no ledger debit |
| Remediation | Post `WEEKLY_PAYOUT` **−5641p** **only after** finance reconciles wallet vs transfer sum (see §6.1) |

### 4.2 £16.93 — Ahmed payout

| Field | Value |
|-------|-------|
| Stripe | `po_1TjTPXEXTz9Ab5IcE2GFPiaq`, **1693p**, **paid**, 18 Jun 00:02 UTC |
| Driver | **MK0001** Ahmed |
| Mechanism | Automatic Connect sweep (precedes manual £4.57 payout same day) |
| ONECAB gap | No ledger debit |
| Remediation | Post `WEEKLY_PAYOUT` **−1693p** via idempotent RPC (§6.2) |

### 4.3 £9.43 — unmatched bank credit

| Field | Value |
|-------|-------|
| Bank evidence | +£9.43, Stripe Payments UK / ONECAB LIMITED, **17 Jun 2026** |
| Stripe (current MK accounts) | **No** `po_*` for **943p** since 2026-01-01 |
| Closest candidates | Platform `po_1TdK3K` **£9.94** (1 Jun, corporate); transfer pair 535+408=943p (settlements, not bank); legacy `po_1Tffdp` **£7.77** (wrong amount/account) |
| Remediation | **None** until bank reference ↔ Stripe ID confirmed — **do not invent ledger** |

### 4.4 £4.57 — Ahmed manual (for completeness)

| Field | Value |
|-------|-------|
| Stripe | `tr_1TjazzEeK1Cb9ZBxr9bq5kdd` + `po_1Tjb00EXTz9Ab5IcGLdtDR2s` |
| Ledger | ✅ MANUAL_PAYOUT −457p |
| Gap | `payout_item` not linked; duplicate weekly item |

---

## 5. Root cause taxonomy

| Class | Count | Cause |
|-------|------:|-------|
| **A — Auto Connect sweep** | 2 | Stripe paid Connect balance to bank without `admin-sync-payout-ledger` / orphan discovery |
| **B — Engine payout, broken item link** | 1 | Manual payout wrote ledger but not `payout_item.ledger_entry_id` |
| **C — Test-day reset** | 2+ | 1 Jun 2026 deleted all ledger + payout_items; Stripe money already moved |
| **D — Ghost batches** | 2 | Admin batch shells £42.08, no Stripe payout |
| **E — Unmatched bank** | 1 | £9.43 — no Stripe object on current accounts |

---

## 6. Recommended remediation entries (DO NOT EXECUTE)

Use existing idempotent RPC `insert_payout_ledger_debit_if_missing()` + `recalculate_driver_wallet()` per migration `20260611120000`. **No Stripe API calls required** for ledger backfill.

### 6.1 MK0002 — `po_1TjUCp…` (£56.41)

**Option A (full Stripe match — finance approval required):**

```sql
-- PROPOSED ONLY — DO NOT RUN WITHOUT SIGN-OFF
SELECT insert_payout_ledger_debit_if_missing(
  p_driver_id := 'cd8bae4c-3827-4b90-98c6-10be70eb0e52',
  p_amount_pence := -5641,
  p_ledger_type := 'WEEKLY_PAYOUT',
  p_currency := 'GBP',
  p_description := 'Phase 3C.5 remediation — Stripe auto payout po_1TjUCpIzd0dzmC0Y65sJxUHu',
  p_stripe_transfer_id := NULL,
  p_stripe_payout_id := 'po_1TjUCpIzd0dzmC0Y65sJxUHu',
  p_paid_at := '2026-06-18T00:53:19Z'
);
SELECT recalculate_driver_wallet('cd8bae4c-3827-4b90-98c6-10be70eb0e52');
```

**Option B (wallet-safe partial — if finance caps debit at wallet SSOT):**

```sql
-- PROPOSED ONLY — debit min(wallet_ssot, stripe_paid) = 1901p; residual 3740p → finance adjustment / investigation
-- p_amount_pence := -1901
```

**Also recommend:** retrospective `payout_batch` + `payout_item` (status `completed`, `stripe_payout_id` set) for audit trail — or document as **ledger-only remediation** batch `REMEDIATION_3C5`.

### 6.2 MK0001 — `po_1TjTPX…` (£16.93)

```sql
-- PROPOSED ONLY
SELECT insert_payout_ledger_debit_if_missing(
  p_driver_id := '5ed232c3-8bb5-4085-95d6-73e48e6c5e28',
  p_amount_pence := -1693,
  p_ledger_type := 'WEEKLY_PAYOUT',
  p_currency := 'GBP',
  p_description := 'Phase 3C.5 remediation — Stripe auto payout po_1TjTPXEXTz9Ab5IcE2GFPiaq',
  p_stripe_transfer_id := NULL,
  p_stripe_payout_id := 'po_1TjTPXEXTz9Ab5IcE2GFPiaq',
  p_paid_at := '2026-06-18T00:02:23Z'
);
SELECT recalculate_driver_wallet('5ed232c3-8bb5-4085-95d6-73e48e6c5e28');
```

**Projected wallet:** 1,780 − 1,693 = **87p**.

### 6.3 MK0001 — `po_1Tjb00…` (£4.57) — link only, no new ledger

```sql
-- PROPOSED ONLY — ledger row 3448df70 already exists
UPDATE payout_items SET
  ledger_entry_id = '3448df70-8f1e-4bcf-9062-dfb2fcc3f8ef',
  stripe_payout_id = 'po_1Tjb00EXTz9Ab5IcGLdtDR2s',
  stripe_transfer_id = 'tr_1TjazzEeK1Cb9ZBxr9bq5kdd',
  status = 'completed',
  completed_at = COALESCE(completed_at, '2026-06-18T08:08:32Z'),
  wallet_recalculated_at = COALESCE(wallet_recalculated_at, now())
WHERE id = '2c50b7df-dcae-40be-9888-f89f061e0f4b';
```

### 6.4 Duplicate weekly item — cancel

```sql
-- PROPOSED ONLY
UPDATE payout_items SET
  status = 'failed',
  failure_code = 'DUPLICATE_SUPERSEDED',
  failure_reason = 'Phase 3C.5 — duplicate of manual payout tr_1Tjazz',
  settlement_status = 'FAILED'
WHERE id = 'c5bcd2f7-36f6-44ba-a36d-9822ac32ed44';
-- Optionally set batch 8fdc9ed8 status FAILED or leave READY with zero active items
```

### 6.5 Legacy pre-reset payouts (separate track)

| Payout | Proposed entry | Driver ID | Note |
|--------|----------------|-----------|------|
| `po_1TgwCx…` −4116p | `WEEKLY_PAYOUT` | **Finance choice:** old `58b29f86-…` vs current MK0001 | May double-count if same person re-provisioned |
| `po_1Tffdp…` −777p | `EARLY_CASHOUT` | Same | Confirm bank receipt |

**Alternative:** Supabase **PITR** restore pre–1 Jun ledger instead of synthetic inserts.

### 6.6 £9.43 — **no recommended entry**

Hold until Stripe payout ID confirmed. If matched to legacy account, use §6.5 pattern.

### 6.7 Orphan £42.08 batches — **no ledger entry**

Mark archived in ops runbook only.

---

## 7. Post-remediation verification checklist

- [ ] `SELECT * FROM driver_wallet_ledger WHERE stripe_payout_id IN ('po_1TjUCp…','po_1TjTPX…','po_1Tjb00…')` — one row each
- [ ] MK0001 wallet ≈ **87p** (if −1693 applied)
- [ ] MK0002 wallet reviewed (may be negative if −5641 applied)
- [ ] `payout_items` duplicate `c5bcd2f7` failed; `2c50b7df` completed + linked
- [ ] `driver_financial_summary.wallet_balance` matches ledger SSOT (post 3C.4 migration)
- [ ] Re-run `stripe-reconciliation-audit` — zero orphan connected payouts
- [ ] Ahmed manual UI sign-off

---

## 8. GO / NO-GO — finance correction deployment

| Gate | Status |
|------|--------|
| All paid Stripe Connect payouts have ledger debits | ❌ (2 orphans + legacy) |
| Remediation SQL idempotent (unique on `stripe_payout_id`) | ✅ RPC exists |
| MK0002 wallet impact understood | ❌ (may go **−£37.40**) |
| £9.43 resolved or scoped out | ❌ |
| Duplicate payout items cleaned | ❌ |
| Phase 3C.4 wallet SSOT deployed | ⏳ pending |
| Ahmed / finance written approval | ❌ |

### Verdict: **NO-GO**

Deploy finance correction **only after**:

1. **Finance sign-off** on MK0002 Option A vs B (§6.1).  
2. **£9.43** bank reference matched or formally written off.  
3. **Bundled deployment:** 3C.4 wallet migration + remediation script + payout_item hygiene.  
4. **Staging dry-run** of `insert_payout_ledger_debit_if_missing` for both `po_*` ids.  
5. **Process fix:** enable `admin-sync-payout-ledger` orphan discovery on schedule / post-settlement so auto Connect sweeps cannot recur without ledger.

---

## 9. References

- `docs/PHASE_3C4_STRIPE_RECONCILIATION_AUDIT.md`
- `docs/PHASE_3C03H_HISTORICAL_RESET_AUDIT.md`
- `docs/p0-payout-ledger-sync-fix-report.md`
- `supabase/migrations/20260611120000_p0_payout_ledger_sync_fix.sql`
- `supabase/functions/admin-sync-payout-ledger/index.ts` — `discoverOrphanStripePayouts`
- Raw JSON: `/tmp/stripe-recon-full.json` (2026-06-18 audit run)
