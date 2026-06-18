# Phase 3C.4 — Stripe Payout Reconciliation Audit

**Date:** 2026-06-18  
**Status:** Read-only audit  
**Project:** `thazislrdkjpvvghtvzo` (ONECAB prod)  
**Stripe window:** 2026-05-01 → 2026-06-18 (UTC)  
**Method:** Live Stripe API via read-only edge `stripe-reconciliation-audit` + prod DB (service role)

---

## Executive summary

| Bank credit (evidence) | Stripe match | ONECAB DB match | Status |
|------------------------|--------------|-----------------|--------|
| **£56.41** (18 Jun) | **Yes** — `po_1TjUCp…` 5641p | **No** ledger / payout_item | **MISMATCH** |
| **£16.93** (18 Jun, Stripe) | **Yes** — `po_1TjTPX…` 1693p | **No** ledger / payout_item | **MISMATCH** |
| **£4.57** (18 Jun manual) | **Yes** — `tr_1Tjazz…` + `po_1Tjb00…` 457p pending | Partial — ledger yes, item lifecycle broken | **PARTIAL** |
| **£9.43** (17 Jun, bank) | **No** 943p payout on current Connect accounts | **None** | **UNMATCHED** |

**Critical correction vs 3C.3H:** **£56.41** is Stripe Connect bank payout on **MK0002 (Asiya Wehliye)** account `acct_1ThUR8Izd0dzmC0Y`, **not** MK0001 (Ahmed). Verify which bank account received the credit.

**Verdict: NO-GO** for payout enablement until automatic Connect sweeps are ledger-synced and orphan/duplicate payout rows are cleared.

---

## 1. Stripe retrieval (since 2026-05-01)

### 1.1 Platform account (ONECAB Ltd)

**Payouts to ONECAB bank** (5):

| Stripe payout ID | Amount | Status | Created (UTC) |
|----------------|-------:|--------|---------------|
| `po_1TiO2IEeK1Cb9ZBxM42lTU2Q` | £13.36 (1336p) | paid | 2026-06-15 |
| `po_1TgZwZEeK1Cb9ZBx3aJ0fUch` | £28.87 (2887p) | paid | 2026-06-10 |
| `po_1TdK3KEeK1Cb9ZBxoRCajakm` | **£9.94** (994p) | paid | 2026-06-01 |
| `po_1TYEd8EeK1Cb9ZBxP91Sx5MO` | £7.40 (740p) | paid | 2026-05-18 |
| `po_1TTXAZEeK1Cb9ZBxroC6pEvU` | £4.52 (452p) | paid | 2026-05-05 |

These are **platform** settlements to ONECAB corporate bank — not driver Connect payouts. Closest amount to **£9.43** is **£9.94** (51p gap).

**Transfers to Connect** (platform → connected): **19** transfers since May 1 (trip settlement), totalling trip earnings to driver accounts (see §3).

### 1.2 Connected accounts (drivers)

**Payouts to driver bank** (3):

| Driver | Stripe payout ID | Amount | Status | Created (UTC) | Arrival (UTC) |
|--------|------------------|-------:|--------|---------------|---------------|
| **MK0002** Asiya | `po_1TjUCpIzd0dzmC0Y65sJxUHu` | **£56.41** (5641p) | **paid** | 2026-06-18 00:53 | 2026-06-18 |
| **MK0001** Ahmed | `po_1TjTPXEXTz9Ab5IcE2GFPiaq` | **£16.93** (1693p) | **paid** | 2026-06-18 00:02 | 2026-06-18 |
| **MK0001** Ahmed | `po_1Tjb00EXTz9Ab5IcGLdtDR2s` | **£4.57** (457p) | **pending** | 2026-06-18 08:08 | 2026-06-18 |

**No** 943p (`£9.43`) connected payout exists on `acct_1ThTrEEXTz9Ab5Ic` or `acct_1ThUR8Izd0dzmC0Y` in this window.

### 1.3 Balance transactions (platform, payout/transfer linked)

37 platform balance transactions captured; payout-type entries mirror platform `po_*` list above. Connected-account balance transactions were not fully retrieved (auth helper on secondary edge); connected payout objects above are authoritative for driver bank credits.

---

## 2. ONECAB surviving records

### 2.1 `payout_batches` (4)

| Batch ID | Date | Kind | Amount | Status | Items |
|----------|------|------|-------:|--------|-------|
| `99e964b1-…` | 2026-06-10 | MANUAL_ADMIN | £42.08 | INVALID_ORPHANED | **0** |
| `06b1c321-…` | 2026-06-10 | MANUAL_ADMIN | £42.08 | INVALID_ORPHANED | **0** |
| `8fdc9ed8-…` | 2026-06-18 | WEEKLY_MONDAY | £4.57 | READY | 1 (no Stripe ids) |
| `d627233c-…` | 2026-06-18 | MANUAL_ADMIN | £4.57 | completed | 1 (`tr_1Tjazz…`) |

### 2.2 `payout_items` (2)

| Item ID | Driver | Amount | Batch | Stripe transfer | Stripe payout | Ledger link | Provider |
|---------|--------|-------:|-------|-----------------|---------------|-------------|----------|
| `c5bcd2f7-…` | MK0001 | 457p | weekly | — | — | — | — |
| `2c50b7df-…` | MK0001 | 457p | manual | —* | —* | — | `tr_1Tjazz…` paid |

\*Columns `stripe_transfer_id` / `stripe_payout_id` null; `provider_reference` = `tr_1TjazzEeK1Cb9ZBxr9bq5kdd`.

### 2.3 `driver_wallet_ledger` payout debits (1)

| Ledger ID | Driver | Type | Amount | Transfer | Payout |
|-----------|--------|------|-------:|----------|--------|
| `3448df70-…` | MK0001 | MANUAL_PAYOUT | −457p | `tr_1Tjazz…` | `po_1Tjb00…` |

**No** `WEEKLY_PAYOUT`, `EARLY_CASHOUT`, or payout debits for MK0002 despite **£56.41** paid by Stripe.

### 2.4 `driver_early_cashouts`

**Empty** (pre-reset cashout rows deleted 2026-06-01).

---

## 3. Transfer ↔ payout reconciliation

### MK0002 — £56.41 explained

| Metric | Pence |
|--------|------:|
| Sum of platform → Connect **transfers** (12 trips) | **5,641** |
| Stripe Connect **bank payout** `po_1TjUCp…` | **5,641** |
| ONECAB ledger payout debit | **0** |

**Conclusion:** £56.41 is Stripe’s **automatic standard payout** of accumulated Connect balance from card trip transfers. It did **not** flow through `admin-driver-payout` / weekly settlement. Wallet SSOT still shows **£19.01** liability for MK0002 — **not reduced** by this bank payment.

### MK0001 — Ahmed

| Metric | Pence |
|--------|------:|
| Sum of platform → Connect transfers (7) | **3,104** |
| Connect bank payout `po_1TjTPX…` (paid) | **1,693** |
| Connect bank payout `po_1Tjb00…` (pending) | **457** |
| ONECAB ledger payout debits | **−457** only |

**1,693p** left Connect to bank **without** a matching `WEEKLY_PAYOUT` / `MANUAL_PAYOUT` ledger row. **457p** manual payout is partially recorded (ledger + item; duplicate weekly item orphan).

---

## 4. Bank credit reconciliation table

| Bank amount | Date (bank) | Stripe payout ID | Stripe transfer ID | Driver | Ledger debit | Batch / item | Reconciliation |
|-------------|-------------|------------------|--------------------|--------|--------------|--------------|----------------|
| **£56.41** | 18 Jun 2026 | `po_1TjUCpIzd0dzmC0Y65sJxUHu` | — (auto sweep) | **MK0002** Asiya | **None** | **None** | **MISMATCH** — money left Connect; wallet/ledger unchanged |
| **£16.93**† | 18 Jun 2026 | `po_1TjTPXEXTz9Ab5IcE2GFPiaq` | — (auto sweep) | **MK0001** Ahmed | **None** | **None** | **MISMATCH** — no ledger debit |
| **£4.57** | 18 Jun 2026 (pending arrival) | `po_1Tjb00EXTz9Ab5IcGLdtDR2s` | `tr_1TjazzEeK1Cb9ZBxr9bq5kdd` | **MK0001** Ahmed | MANUAL_PAYOUT −457p | `d627233c` / `2c50b7df` | **PARTIAL** — ledger OK; item `status=pending`; duplicate weekly item `c5bcd2f7` |
| **£9.43** | 17 Jun 2026 | **Not found** | **Not found** | Unknown | **None** | **None** | **UNMATCHED** |

†Not in user bank screenshots but exists in Stripe as paid Connect payout same arrival window as £56.41.

### £9.43 investigation

| Candidate | Amount | Why ruled in/out |
|-----------|-------:|------------------|
| Connect payout `po_*` 943p | — | **No** such payout on current MK accounts since May 1 |
| Platform payout `po_1TdK3K` | £9.94 (1 Jun) | ONECAB **corporate** bank, not driver Connect descriptor; 51p off |
| Transfer pair 535p + 408p | £9.43 sum | Trip **settlements to Connect**, not bank credits |
| Pre-reset `po_1Tffdp` | £7.77 | Deleted DB; wrong account (peek 500 on current acct) |
| Pre-reset `po_1TgwCx` | £41.16 | Deleted DB; wrong account |

**Action:** Match bank statement **reference** field to Stripe payout ID. If account is Ahmed’s, check **legacy** Connect account tied to deleted driver `58b29f86-…`.

---

## 5. Explainer sections

### 5.1 £56.41 bank credit

- **Stripe:** `po_1TjUCpIzd0dzmC0Y65sJxUHu`, **5641p**, **paid**, MK0002 Connect account.
- **Mechanism:** Automatic payout of **full Connect balance** equal to sum of trip **transfers** (5641p) — not an ONECAB payout-engine batch.
- **ONECAB gap:** Zero `payout_items`, zero ledger debit → **driver wallet overstates liability** vs cash already sent to bank.
- **3C.3H attribution error:** Previously discussed as Ahmed/MK0001; Stripe proves **Asiya/MK0002** unless both drivers share one bank account on file.

### 5.2 £9.43 bank credit

- **No exact Stripe payout** on surviving Connect accounts.
- Nearest platform payout **£9.94** (1 Jun) — different recipient class and date.
- Most likely: **legacy Connect account** (pre–12 Jun driver re-provision), **manual corporate transfer**, or **misread amount** (£16.93 vs £9.43). Requires bank **reference** + Stripe global payout search.

### 5.3 £42.08 orphan payouts

- Two `payout_batches` on **2026-06-10**, `total_amount_pence = 4208`, **zero** `payout_items`.
- Amount equals **pre-reset Ahmed wallet** (£42.08) from `docs/p0-payout-ledger-sync-fix-report.md`.
- Marked `INVALID_ORPHANED` by migration `20260715120000` (`ORPHANED_NO_ITEMS`).
- **No Stripe transfer** — failed admin batch shells only; **not** bank money movement.

### 5.4 Deleted pre-reset payouts

**2026-06-01 Test Day Reset** deleted all `payout_items` and `driver_wallet_ledger` (600 rows). Stripe retained:

| Historical payout (docs) | Amount | Stripe ID | DB today |
|--------------------------|-------:|-----------|----------|
| Weekly bank payout | £41.16 | `po_1TgwCxImYgLhqfX02AUIfT8F` | **Deleted** (backfill wiped) |
| Early cashout | £7.77 | `po_1TffdpImYgLhqfX0coqg8arU` | **Deleted** |
| Pre-reset payout_items | various | — | **5 rows deleted** |

Stripe money movement may have occurred; **ONECAB audit trail is broken** for pre–1 Jun period.

---

## 6. Stripe ↔ ONECAB match matrix (all connected bank payouts)

| Stripe payout | Driver | Bank £ | Ledger | payout_item | Engine |
|---------------|--------|-------:|--------|-------------|--------|
| `po_1TjUCp…` | MK0002 | 56.41 | ❌ | ❌ | Stripe auto |
| `po_1TjTPX…` | MK0001 | 16.93 | ❌ | ❌ | Stripe auto |
| `po_1Tjb00…` | MK0001 | 4.57 | ✅ −457p | ⚠️ partial | `admin-driver-payout` |

---

## 7. GO / NO-GO

| Gate | Result |
|------|--------|
| Every bank credit has payout_item + ledger | ❌ |
| No automatic Connect sweeps without ledger | ❌ (£56.41 + £16.93) |
| £9.43 explained | ❌ |
| Orphan £42.08 batches resolved | ❌ (marked orphaned only) |
| Duplicate 457p items cleared | ❌ |
| Pre-reset trail recoverable | ❌ without PITR |

### **NO-GO** for production payout enablement

**Required before GO:**

1. **`admin-sync-payout-ledger` / discover orphan** — backfill ledger debits for `po_1TjUCp…` (−5641p MK0002) and `po_1TjTPX…` (−1693p MK0001) or confirm intentional auto-payout policy with ledger writes.
2. **Resolve £9.43** — bank reference ↔ Stripe (incl. legacy accounts).
3. **Cancel duplicate** item `c5bcd2f7-…`; fix `2c50b7df` status vs `completed` batch.
4. **Archive** `INVALID_ORPHANED` £42.08 batches after finance sign-off.
5. Deploy Phase **3C.4** wallet SSOT + re-verify MK wallets.

---

## 8. Audit artifacts

| Artifact | Location |
|----------|----------|
| Raw Stripe + DB JSON | `/tmp/stripe-recon-audit.json` (local run 2026-06-18) |
| Read-only edge (deployed for audit) | `stripe-reconciliation-audit` |
| Prior reset audit | `docs/PHASE_3C03H_HISTORICAL_RESET_AUDIT.md` |

---

## 9. References

- `docs/test-day-reset-report.md`
- `docs/p0-payout-ledger-sync-fix-report.md`
- `docs/PHASE_3C03H_HISTORICAL_RESET_AUDIT.md`
- `supabase/functions/admin-sync-payout-ledger/index.ts` — orphan Stripe payout discovery
