# Phase 3C.3H — Historical Reset & Payout Reconstruction Audit

**Date:** 2026-06-18  
**Status:** Read-only audit — **no implementation**  
**Project:** `thazislrdkjpvvghtvzo` (ONECAB prod)  
**Region:** MK — `7f611e59-a9e5-42c2-b65a-61376910bb5d`

| Driver | Code | ID |
|--------|------|-----|
| Ahmed Osman | MK0001 | `5ed232c3-8bb5-4085-95d6-73e48e6c5e28` |
| Asiya Wehliye | MK0002 | `cd8bae4c-3827-4b90-98c6-10be70eb0e52` |

**Evidence reviewed:** Prod SQL (service role, read-only), migration files, `docs/test-day-reset-report.md`, payout fix reports, admin screenshots (bank £56.41, Payout Batches, Monday Payout Audit).

---

## Executive summary

| Question | Verdict |
|----------|---------|
| Was historical balance **lost**? | **Yes** — pre–2026-06-01 ledger/payout/trip history was bulk-deleted (600 ledger rows, 5 payout items, 1,446 trips). Not recoverable from app DB without PITR. |
| Was balance **duplicated**? | **Partial risk** — 18 Jun duplicate £4.57 payout batches (weekly + manual) created £9.14 pending UI exposure; only one ledger debit (−457p) and one Stripe transfer recorded. |
| Was payout history **orphaned**? | **Yes** — two 10 Jun batches (£42.08 each) are `INVALID_ORPHANED` with **zero** `payout_items`; pre-reset payout rows were deleted on 1 Jun. |
| Does **£56.41** reconcile to platform records? | **No** — no single payout record equals 5641p. Best arithmetic splits: **£42.08 + £14.33** or **£41.16 + £15.25** (pre-reset-era amounts). Requires Stripe bank-payout export to close. |
| Is production finance data **trustworthy**? | **No** — admin wallet view drift (3C.03F), duplicate payout shells, orphaned batches, and bank/platform amount mismatch. |
| **GO / NO-GO** payout enablement | **NO-GO** |

---

## 1. Bulk delete / reset operations (last 30 days)

### 1.1 Primary event — Test Day Reset (2026-06-01)

**Migration:** `20260601073816_d3b0dceb-47f6-4375-a78a-abb386c5daba.sql`  
**Report:** `docs/test-day-reset-report.md`

| Table | Rows before | Rows after |
|-------|------------:|-----------:|
| `trips` | 1,446 | 0 |
| `driver_wallet_ledger` | 600 | 0 |
| `payout_items` | 5 | 0 |
| `payout_batches` | 0 | 0 |
| `customer_wallet_ledger` | 0 | 0 |
| `driver_statements` | 0 | 0 |

Also deleted: dispatch logs, `ride_offers`, `trip_stops`, `trip_finance`, etc.  
**Retained:** `drivers` (5), `customers` (7), Stripe config, auth users, settings.  
**`driver_wallets`:** all caches zeroed (`available_pence`, `pending_pence`, `lifetime_earned_pence`).

This is the **driver/customer reset ~two weeks ago** referenced in the audit brief. It is destructive and documented as non-rollback-able without Supabase PITR.

### 1.2 Other destructive migrations in window (May 19 – Jun 18)

| Date | Migration | Scope |
|------|-----------|--------|
| 2026-06-10 | *(batch shells created in prod)* | Two `MANUAL_ADMIN` batches £42.08 — later marked orphaned |
| 2026-06-18 | `20260715120000` *(applied prod)* | Marks batches with amount but no items → `INVALID_ORPHANED` |
| 2026-06-17 | `20260617130000` | Customer code renumber (not financial delete) |
| 2026-06-12 | `20260612153000` | MK driver code renumber MK0003/4 → MK0001/2 |
| 2026-06-11 | `20260611120000` | Payout ledger sync fix + backfill RPCs |
| 2026-06-01 | `20260601073816` | **Full test-day reset** (above) |

**Not in last 30 days but relevant precedent:** `20260417181928` (ledger/trips/payout wipe), `20260412122543` (all customers deleted), `20260407104000` (ledger wipe).

### 1.3 Operational writes outside migrations (18 Jun 2026)

Documented in `docs/PHASE_3C3E_PRODUCTION_VERIFICATION_REPORT.md`:

| Action | Effect |
|--------|--------|
| `admin-weekly-monday-settlement` | Batch `8fdc9ed8-…` — WEEKLY_MONDAY £4.57, item `c5bcd2f7-…` **pending** |
| `admin-driver-payout` | Batch `d627233c-…` — MANUAL_ADMIN £4.57, transfer `tr_1TjazzEeK1Cb9ZBxr9bq5kdd`, ledger `MANUAL_PAYOUT` −457p |

No `truncate` on finance tables in the last 30 days other than the 1 Jun migration.

---

## 2. Ledger reconstruction — MK0001 & MK0002

Formula (Phase 3A.4 SSOT — excludes `PLATFORM_COMMISSION`, `CASH_TRIP_EARNING` only):

```
Opening (0)
+ Trip earnings (TRIP_EARNING_NET)
+ Tips (DRIVER_TIP_CREDIT / TIP_CREDIT)
+ Cash commission debt (CASH_COMMISSION_DEBT, negative)
+ Commission recovered (COMMISSION_RECOVERED)
+ Debt recovery (DEBT_RECOVERY, negative)
− Payouts (MANUAL_PAYOUT / PAYOUT / WEEKLY_PAYOUT / EARLY_CASHOUT)
− Cashout fees
+ Adjustments / bonuses
± Reversals (LEDGER_REVERSAL)
= Current wallet
```

### MK0001 — Ahmed Osman

| Component | Pence | £ |
|-----------|------:|--:|
| Opening | 0 | £0.00 |
| Trip earnings | +3,083 | £30.83 |
| Tips | 0 | £0.00 |
| Cash commission debt | −846 | −£8.46 |
| Commission recovered | +846 | £8.46 |
| Debt recovery | −846 | −£8.46 |
| Payouts | −457 | −£4.57 |
| Reversals / adjustments / cashouts | 0 | £0.00 |
| **Reconstructed wallet** | **1,780** | **£17.80** |

**Prod verification (18 Jun):**

| Surface | Wallet pence | Match SSOT? |
|---------|-------------:|:-----------:|
| Ledger sum (SSOT) | 1,780 | ✓ |
| `driver_wallets.available_pence` | 1,780 | ✓ |
| `driver_financial_summary.wallet_balance` | **934** | ❌ (3C.03F — excludes `COMMISSION_RECOVERED`) |
| Driver app (`driver-wallet-summary`) | 1,780 | ✓ (per 3C.3e verification) |

First ledger entry: **2026-06-12** (driver `created_at` 2026-06-12). No ledger existed on **2026-06-10** (orphan batch date).

### MK0002 — Asiya Wehliye

| Component | Pence | £ |
|-----------|------:|--:|
| Opening | 0 | £0.00 |
| Trip earnings | +6,049 | £60.49 |
| Tips | +100 | £1.00 |
| Cash commission debt | −2,708 | −£27.08 |
| Commission recovered | +2,708 | £27.08 |
| Debt recovery | −2,708 | −£27.08 |
| Ledger reversals (capture_failed backfill) | −1,540 | −£15.40 |
| Payouts | 0 | £0.00 |
| **Reconstructed wallet** | **1,901** | **£19.01** |

| Surface | Wallet pence | Match SSOT? |
|---------|-------------:|:-----------:|
| Ledger sum (SSOT) | 1,901 | ✓ |
| `driver_wallets.available_pence` | 1,901 | ✓ |
| `driver_financial_summary.wallet_balance` | **−807** | ❌ (3C.03F) |
| Driver app | 1,901 | ✓ |

**109 ledger rows** (2026-06-12 → 2026-06-15). `amount_owed_to_onecab = 0` for both drivers (cash debt fully recovered).

---

## 3. Ahmed Osman — complete payout reconstruction

### 3.1 Current DB (post-reset, MK0001 id)

| # | Run date | Batch ID | Kind | Batch status | Item ID | Amount | Item status | Settlement | Stripe transfer | Stripe payout | Ledger debit | Ledger ID |
|---|----------|----------|------|--------------|---------|-------:|-------------|------------|-----------------|---------------|--------------|-----------|
| 1 | 2026-06-18 | `8fdc9ed8-5049-46ef-b8d3-e7bb5087f7e1` | WEEKLY_MONDAY | READY | `c5bcd2f7-…` | 457p | pending | READY | — | — | **none** | — |
| 2 | 2026-06-18 | `d627233c-4d4d-4114-b9d9-d5e01c54aa30` | MANUAL_ADMIN | completed | `2c50b7df-…` | 457p | pending* | COMPLETE | `tr_1TjazzEeK1Cb9ZBxr9bq5kdd` | `po_1Tjb00EXTz9Ab5IcGLdtDR2s` | **MANUAL_PAYOUT −457p** | `3448df70-…` |

\*Item `status` still `pending` while batch `completed` and `provider_status = paid` — lifecycle inconsistency (Monday Audit **MISMATCH** in screenshot).

**Also:** `PAYOUT_CREATED` 0p audit row for batch `d627233c-…`.

### 3.2 Orphaned batch shells (no items)

| Run date | Batch ID | Amount | Status | Notes |
|----------|----------|-------:|--------|-------|
| 2026-06-10 | `99e964b1-9050-4995-9f1b-c70c7e31b81a` | 4,208p (£42.08) | INVALID_ORPHANED | Zero `payout_items` |
| 2026-06-10 | `06b1c321-3ec8-4b3d-8f6d-47d3f7afbc59` | 4,208p (£42.08) | INVALID_ORPHANED | Zero `payout_items` |

Marked by migration `20260715120000` (`ORPHANED_NO_ITEMS`). Amount **4208p** matches pre-reset Ahmed wallet from `docs/p0-payout-ledger-sync-fix-report.md` — ghost references to deleted history.

### 3.3 Pre-reset payouts (deleted 2026-06-01 — not in DB)

From `docs/p0-payout-ledger-sync-fix-report.md` and `docs/p0-payout-batches-audit-zeros-fix-report.md` (driver id then `58b29f86-…`, since replaced):

| Event | Amount | Stripe ref | Ledger | Fate |
|-------|-------:|------------|--------|------|
| Weekly bank payout | 4,116p (£41.16) | `po_1TgwCxImYgLhqfX02AUIfT8F` | Backfilled `WEEKLY_PAYOUT` −4116p on 2026-06-11 | **Deleted** on 1 Jun reset before fix persisted in current ledger |
| Early cashout | 777p (£7.77) | `po_1TffdpImYgLhqfX0coqg8arU` | Unknown in current DB | **Deleted**; `driver_early_cashouts` now **empty** |

### 3.4 Platform total vs bank

| Source | Total to Ahmed |
|--------|---------------:|
| **ONECAB ledger payout debits (current DB)** | **457p (£4.57)** |
| **ONECAB payout_items (completed transfers)** | **457p** (one item with `provider_reference`) |
| **Bank evidence (screenshot)** | **5,641p (£56.41)** ONECAB LIMITED, 18 Jun 09:18 |
| **Gap** | **5,184p (£51.84)** unexplained in platform |

---

## 4. £56.41 bank payment investigation

**Bank evidence:** Credit **+£56.41** from **ONECAB LIMITED**, Thu 18 Jun 09:18, type “3rd Party Payment”, account BBA OVDRFT.

**Platform same day:** Manual payout **£4.57** at 08:08 UTC (`tr_1Tjazz…`, `po_1Tjb00…`). Amount and timing do **not** match a simple 1:1 payout→bank mapping.

### Arithmetic decompositions (5641p)

| Hypothesis | Sum | Notes |
|------------|----:|-------|
| £42.08 + £14.33 | 5,641 | £42.08 = orphan batch / pre-reset wallet SSOT |
| £41.16 + £15.25 | 5,641 | £41.16 = deleted weekly payout doc |
| £4.57 + £51.84 | 5,641 | £51.84 = residual Stripe Connect balance paid to bank in same sweep |

### Classification

| Option | Likelihood | Rationale |
|--------|------------|-----------|
| Single payout record in ONECAB | **Ruled out** | No 5641p batch/item/ledger row |
| Multiple payout items same day | **Partial** | Only 457p item exists; weekly duplicate has no transfer |
| Accumulated Stripe Connect → bank sweep | **Plausible** | Connect can pay **full available balance** to bank; DB reset on 1 Jun does not zero Stripe-side balance |
| Manual corporate transfer outside engine | **Plausible** | “3rd Party Payment” label; no bank reference in DB |
| Settlement batch total | **Unlikely** | MK region liability ~£37+ today; not £56.41 |

**Required to close:** Stripe Dashboard → Connect account `acct_1ThTrEEXTz9Ab5Ic` → Payouts on **18 Jun 2026** — match `po_1Tjb00…` **bank amount** vs **transfer amount**; list any additional payouts to Ahmed’s bank account.

**No matching bank transfer reference** stored in `payout_items` for 5641p (reference field empty on weekly item; manual item has transfer id only).

---

## 5. Historical wallet — before / after reset / today

MK0001 and MK0002 **did not exist** until **2026-06-12** (`drivers.created_at`). Per-driver wallets before that date are **N/A** (not the same UUID lineage as pre-reset `58b29f86-…` Ahmed record, which is absent from current `drivers` table).

### Platform-level

| Milestone | MK0001 wallet (SSOT) | MK0002 wallet (SSOT) | Notes |
|-----------|---------------------:|---------------------:|-------|
| **Before reset** (≤ 2026-05-31) | N/A | N/A | Pre-reset Ahmed wallet was **4,208p** on deleted driver id |
| **After reset** (2026-06-01) | 0 | 0 | All ledger wiped; caches zeroed |
| **2026-06-10** | 0 | 0 | Orphan batches £42.08×2 created; no MK ledger yet |
| **2026-06-17** (pre-incident) | **2,237p** | **1,901p** | Per 3C.3e verification |
| **2026-06-18** (post −457p payout) | **1,780p** | **1,901p** | MK0001 manual payout |
| **Today** | **1,780p** | **1,901p** | Ledger + cache agree; admin view wrong |

### Drift introduced by reset

| Drift type | Evidence |
|------------|----------|
| **Lost history** | 600 ledger rows, 5 payout items, 1,446 trips removed 1 Jun |
| **Stripe–DB split** | Stripe PIs/webhooks retained per reset report; trip/ledger links severed |
| **Ghost payout batches** | £42.08 orphan shells reference amounts from deleted era |
| **Definition drift** | Admin `wallet_balance` ≠ ledger SSOT (846p / 2708p per driver) |
| **Duplicate payout exposure** | £9.14 “pending today” = 2× £4.57 items; 1 transfer sent |

---

## 6. Screenshot cross-check (18 Jun admin UI)

| UI observation | DB explanation |
|----------------|----------------|
| Payout Batches: 10 Jun ×2 **INVALID_ORPHANED** £42.08 | Batches `99e964b1`, `06b1c321` — no items |
| 18 Jun Manual **completed** £4.57 | Batch `d627233c` |
| 18 Jun Weekly **READY** £4.57 | Batch `8fdc9ed8` — duplicate |
| Monday Audit: Ahmed ×2 rows, **MISMATCH** | Items `c5bcd2f7` (no transfer) + `2c50b7df` (paid); duplicate net 457p |
| Payout Batches stats: Paid £4.57, Pending £9.14 | One completed + two pending 457p items |
| Finance SSOT: Liability £0, Paid £4.57, **BALANCED** | Region rollup uses broken `wallet_balance` view + narrow period |

---

## 7. Conclusions

### Was historical balance lost?

**Yes.** The 2026-06-01 test-day reset deleted all `driver_wallet_ledger` and `payout_items` rows. Pre-reset Ahmed earnings (~£42.08 wallet, £41.16 paid-out fix, £7.77 cashout) are **not reconstructible from current Postgres** without point-in-time recovery. Post–12 Jun ledger for MK0001/MK0002 is internally consistent.

### Was balance duplicated?

**Not in wallet SSOT** (single −457p debit). **Risk in payout layer:** duplicate 457p batch/item pair leaves a second pending payout shell that could trigger a **second** transfer if executed. UI shows **£9.14 pending** vs **£4.57** actually sent.

### Was payout history orphaned?

**Yes.**

1. **1 Jun:** All `payout_items` deleted; Stripe-side money events decoupled from DB.  
2. **10 Jun:** Two batch records (£42.08) with **no items** — `INVALID_ORPHANED`.  
3. **18 Jun:** Weekly item orphaned from transfer (no `stripe_transfer_id`, no ledger) while manual item holds the transfer.

### Does £56.41 reconcile?

**No — not to current ONECAB records.** Platform records **£4.57** to Ahmed on 18 Jun. **£56.41** requires Stripe bank-payout reconciliation; likely involves **pre-reset Connect balance** and/or **non-payout-engine transfer**, not a single logged `payout_item`.

### Is production finance data trustworthy?

**No**, for payout enablement purposes:

- Destructive reset without full Stripe↔ledger re-sync  
- Orphaned payout batches  
- Duplicate payout items / MISMATCH audit state  
- Admin wallet column ≠ ledger SSOT (Phase 3C.03F; fix in 3C.4 not yet deployed to prod view)  
- Bank receipt ≠ platform payout total  

---

## 8. GO / NO-GO — payout enablement

| Gate | Status |
|------|--------|
| Ledger SSOT internally consistent (MK0001/MK0002) | ✓ |
| Admin wallet display aligned | ❌ (3C.4 migration pending) |
| Payout history complete & auditable | ❌ |
| Bank receipts reconcile to `payout_items` | ❌ (£56.41 open) |
| No duplicate / orphan payout items | ❌ |
| Phase 3C.3e safety gates deployed | ❌ |

### **Verdict: NO-GO**

**Before enablement:**

1. Deploy Phase **3C.4** wallet SSOT migration.  
2. Resolve **£56.41** via Stripe payout export vs bank reference.  
3. Cancel or fail duplicate item `c5bcd2f7-…` (weekly orphan); align item `2c50b7df` status with `completed`.  
4. Archive or delete `INVALID_ORPHANED` batches after finance sign-off.  
5. Re-run read-only `phase3c4-wallet-ssot-verification.ts` + manual MK sign-off.  
6. Ahmed explicit approval for Stripe execution.

---

## 9. References

- `docs/test-day-reset-report.md` / `docs/test-day-reset-backup.md`  
- `docs/p0-payout-ledger-sync-fix-report.md`  
- `docs/p0-payout-batches-audit-zeros-fix-report.md`  
- `docs/PHASE_3C03F_ADMIN_WALLET_BALANCE_AUDIT.md`  
- `docs/PHASE_3C3E_PRODUCTION_VERIFICATION_REPORT.md`  
- `docs/PHASE_3C04_ADMIN_WALLET_SSOT_ALIGNMENT_REPORT.md`  
- Migration `20260601073816` (test-day reset)  
- Migration `20260715120000` (INVALID_ORPHANED marking)
