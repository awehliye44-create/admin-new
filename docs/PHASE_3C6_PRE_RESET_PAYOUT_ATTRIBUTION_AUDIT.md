# Phase 3C.6 — Pre-Reset Payout Attribution Audit

**Date:** 2026-06-18  
**Status:** Read-only — **no writes, no Stripe actions**  
**Project:** `thazislrdkjpvvghtvzo` (ONECAB prod)  
**Payouts under review:**

| Payout | Driver | Amount | Stripe ID |
|--------|--------|-------:|-----------|
| Orphan auto sweep | MK0002 Asiya | **£56.41** (5,641p) | `po_1TjUCpIzd0dzmC0Y65sJxUHu` |
| Orphan auto sweep | MK0001 Ahmed | **£16.93** (1,693p) | `po_1TjTPXEXTz9Ab5IcE2GFPiaq` |

**Related reset:** Test Day Reset **2026-06-01** deleted all trips and ledger (`docs/test-day-reset-report.md`). MK drivers created **2026-06-12**.

---

## Executive conclusion

| Question | Answer |
|----------|--------|
| Are these **pre-reset** payouts (earning ledger deleted 1 Jun)? | **No** |
| Are source earnings in **current** reconstructed wallet liability? | **MK0001: Yes (fully)** · **MK0002: Partially** |
| Overall classification | **Not `PRE_RESET_HISTORY`** — both are **post-reset** Connect sweeps |

| Payout | Primary classification | Rationale |
|--------|------------------------|-----------|
| **£16.93** MK0001 | **`SAFE_LEDGER_BACKFILL`** | Four post-reset card trips; payout = sum of `TRIP_EARNING_NET`; all still in wallet SSOT |
| **£56.41** MK0002 | **`REQUIRES_FINANCE_DECISION`** | Twelve post-reset trips; **£14.40** transferred **after** `LEDGER_REVERSAL`; full debit exceeds wallet SSOT |

---

## 1. Timeline anchor (pre-reset vs post-reset)

| Event | Date | Impact |
|-------|------|--------|
| Test Day Reset | **2026-06-01** | 1,446 trips + 600 ledger rows **deleted** |
| MK0002 driver created | 2026-06-12 11:55 UTC | `cd8bae4c-…` |
| MK0001 driver created | 2026-06-12 11:59 UTC | `5ed232c3-…` |
| Earliest attributed trip (MK0002) | **2026-06-12** 12:38 UTC | After driver creation |
| `po_1TjTPX` paid | 2026-06-18 00:02 UTC | — |
| `po_1TjUCp` paid | 2026-06-18 00:53 UTC | — |

**No source trip predates 2026-06-12.** These payouts cannot be `PRE_RESET_HISTORY` on earning-side ledger — that history was wiped **before** these drivers or trips existed.

---

## 2. MK0001 — £16.93 (`po_1TjTPX`)

### 2.1 Reconstruction — source trips

Stripe Connect auto-payout **1,693p** = sum of **four** platform→Connect transfers, each 1:1 matched to `TRIP_EARNING_NET`:

| Transfer ID | Amount | Trip ID (prefix) | Completed | `TRIP_EARNING_NET` | Wallet contribution |
|-------------|-------:|------------------|-----------|-------------------:|--------------------:|
| `tr_3ThulYEeK1Cb9ZBx1hi9WwGy` | 408p | `a2395aa6-…` | 2026-06-13 | 408p | 408p |
| `tr_3Tig5xEeK1Cb9ZBx0JEUYB46` | 408p | `19fa7bb6-…` | 2026-06-15 | 408p | 408p |
| `tr_3TiiM3EeK1Cb9ZBx0wjpPvlX` | 414p | `35a94438-…` | 2026-06-15 | 414p | 414p |
| `tr_3TiiefEeK1Cb9ZBx0r9CV5M6` | 463p | `a2f530ad-…` | 2026-06-15 | 463p | 463p |
| **Total** | **1,693p** | | | **1,693p** | **1,693p** |

### 2.2 Current wallet / settlement status

| Metric | Pence | Notes |
|--------|------:|-------|
| **Wallet SSOT** (ledger) | 1,780p | Includes −457p `MANUAL_PAYOUT` (separate `po_1Tjb00`) |
| **In-payout trips** (above 4) | 1,693p | Still counted in wallet — **not yet debited** for `po_1TjTPX` |
| **Awaiting settlement** (post-payout, still in wallet) | 1,390p | Trips `05fa9fa8` (436p), `d9f36810` (535p), `cc231cd1` (419p) — transferred to Connect **after** `po_1TjTPX`, partially paid via manual `tr_1Tjazz` (457p) |
| **Ready for payout** (`net_available_for_payout`) | 934p | Admin view (pre-3C.4); ledger cache 1,780p |

### 2.3 Wallet impact if remediated

| Scenario | Projected wallet |
|----------|-----------------:|
| Today | 1,780p |
| After `WEEKLY_PAYOUT` **−1,693p** backfill | **87p** |

Debit equals exactly the four trips’ wallet contribution — **no negative wallet**.

### 2.4 Classification & recommended treatment

| Field | Value |
|-------|-------|
| **Classification** | **`SAFE_LEDGER_BACKFILL`** |
| **Pre-reset?** | **No** — all trips 13–15 Jun 2026 |
| **Earnings in wallet?** | **Yes** — 1,693p of 1,780p current wallet is these trips (remainder: later trips − manual payout) |
| **Recommended treatment** | Idempotent `insert_payout_ledger_debit_if_missing` **−1,693p**, `WEEKLY_PAYOUT`, `stripe_payout_id = po_1TjTPXEXTz9Ab5IcE2GFPiaq`; link retrospective `payout_item` optional; `recalculate_driver_wallet` |

**Not `PRE_RESET_HISTORY`.** This is orphan **reporting** debt, not orphan **economic** earnings.

---

## 3. MK0002 — £56.41 (`po_1TjUCp`)

### 3.1 Reconstruction — source trips

Stripe Connect auto-payout **5,641p** = sum of **twelve** transfers (13 Jun–15 Jun), each matched to a card trip `TRIP_EARNING_NET`:

| Transfer ID | Amount | Trip (prefix) | Completed | `TRIP_EARNING_NET` | Wallet contribution* |
|-------------|-------:|---------------|-----------|-------------------:|---------------------:|
| `tr_3Tht8UEeK1Cb9ZBx0E0VmMU6` | 408p | `7ff25077` | 2026-06-12 | 408p | 408p |
| `tr_3ThtHqEeK1Cb9ZBx1YfyDmHN` | 408p | `3afc4b99` | 2026-06-13 | 408p | **0p** |
| `tr_3ThtJZEeK1Cb9ZBx1BKDsYz7` | 624p | `da239600` | 2026-06-13 | 624p | **0p** |
| `tr_3ThtQSEeK1Cb9ZBx0Nvc30mK` | 624p | `a750e0b7` | 2026-06-13 | 624p | 624p |
| `tr_3ThuJJEeK1Cb9ZBx1mic1euI` | 624p | `1c62afdf` | 2026-06-13 | 624p | 624p |
| `tr_3TicJbEeK1Cb9ZBx1KSALdUW` | 435p | `ba70a843` | 2026-06-15 | 435p | 435p |
| `tr_3TicSGEeK1Cb9ZBx1fsRdZZK` | 408p | `1fb40710` | 2026-06-13 | 408p | **0p** |
| `tr_3TifUHEeK1Cb9ZBx1hufL6Nt` | 408p | `a528e004` | 2026-06-15 | 408p | 408p |
| `tr_3Tig1OEeK1Cb9ZBx1Pfg8hFO` | 441p | `3ede6ebb` | 2026-06-15 | 441p | 441p |
| `tr_3Tij5REeK1Cb9ZBx1WeHYr9Y` | 408p | `27bf96dd` | 2026-06-15 | 408p | 408p |
| `tr_3TijDnEeK1Cb9ZBx0NoULlRT` | 445p | `de1f69a1` | 2026-06-15 | 445p | 445p |
| `tr_3TijZNEeK1Cb9ZBx0KNCjMGd` | 408p | `88439161` | 2026-06-15 | 408p | 408p |
| **Total** | **5,641p** | | | **5,641p** | **4,201p** |

\*Wallet contribution = sum of ledger types excluding `PLATFORM_COMMISSION` / `CASH_TRIP_EARNING` **per trip**.

### 3.2 Reversed trips inside payout set (critical)

Three payout trips have **`LEDGER_REVERSAL`** zeroing per-trip wallet but **transfers still sent**:

| Trip | `TRIP_EARNING_NET` | `LEDGER_REVERSAL` | Net wallet | Transferred |
|------|-------------------:|------------------:|-----------:|------------:|
| `3afc4b99-…` | +408p | −408p | **0p** | 408p |
| `1fb40710-…` | +408p | −408p | **0p** | 408p |
| `da239600-…` | +624p | −724p* | **0p** | 624p |

\*Total `LEDGER_REVERSAL` on MK0002 = −1,540p (= −408 −408 −724).

**£14.40 (1,440p)** left Connect to driver bank for earnings **reversed in ledger** (capture_failed / phantom credit backfill per migration `20260715120000`). This is **not** pre-reset — it is a **post-reset process defect** (transfer after reversal).

### 3.3 Current wallet / settlement status

| Metric | Pence | Notes |
|--------|------:|-------|
| **Wallet SSOT** | 1,901p | All post–12 Jun ledger |
| **In-payout trips** (12 above) | `TRIP_EARNING_NET` 5,641p · wallet contrib **4,201p** | |
| **Not in payout** (held) | 408p | Trip `7e4b6246-…` — `TRIP_EARNING_NET` 408p, not in Connect sweep |
| **Cash debt cycle** | net 0 | `amount_owed_to_onecab = 0` |
| **Ready for payout** | 0p | Admin view (pre-3C.4 drift) |

### 3.4 Wallet impact if remediated

| Scenario | Projected wallet |
|----------|-----------------:|
| Today | 1,901p |
| Full Stripe match **−5,641p** | **−3,740p** |
| Wallet-attributed trips only **−4,201p** | **−2,300p** |
| Exclude reversed-transfer portion **−4,201p** (same as row above for wallet trips) | **−2,300p** |
| Debit only “positive wallet” in-payout trips **−4,201p** | Still **> 1,901p** liability |

**No full debit keeps wallet non-negative without excluding reversed-trip cash.**

### 3.5 Classification & recommended treatment

| Field | Value |
|-------|-------|
| **Classification** | **`REQUIRES_FINANCE_DECISION`** |
| **Pre-reset?** | **No** |
| **Earnings in wallet?** | **Partially** — trip rows exist; **1,440p** banked without wallet liability; net wallet **1,901p < 5,641p** paid |
| **Recommended treatment (options — do not execute)** | |

**Option 1 — Full economic match (finance accepts negative wallet):**  
`WEEKLY_PAYOUT` **−5,641p** linked to `po_1TjUCp…` → wallet **−3,740p**; investigate reversed-trip transfers separately.

**Option 2 — Wallet-safe partial (recommended pending review):**  
Debit **−4,201p** only (trips with positive wallet contribution) → wallet **−2,300p**; finance write-off **−1,440p** reversed-trip bank leakage; Stripe/ops review why transfers fired post-reversal.

**Option 3 — Split components:**  
- **−4,201p** `SAFE_LEDGER_BACKFILL` (wallet-backed)  
- **−1,440p** `REQUIRES_FINANCE_DECISION` (reversal mismatch — clawback / Stripe adjustment / manual adjustment)

**Not `PRE_RESET_HISTORY`.**

---

## 4. Side-by-side attribution summary

| | **£16.93 MK0001** | **£56.41 MK0002** |
|--|-------------------|-------------------|
| **Stripe payout** | `po_1TjTPX…` | `po_1TjUCp…` |
| **Source trips** | 4 card trips (13–15 Jun) | 12 card trips (12–15 Jun) |
| **Pre-reset trips** | **0** | **0** |
| **Sum `TRIP_EARNING_NET`** | 1,693p | 5,641p |
| **Sum wallet contribution** | 1,693p | 4,201p |
| **In wallet SSOT today** | Yes (until backfill) | Partially (1,901p total) |
| **Awaiting settlement** | 1,390p later trips + manual flow | 408p trip not swept |
| **Reversed but transferred** | **0p** | **1,440p** |
| **Classification** | `SAFE_LEDGER_BACKFILL` | `REQUIRES_FINANCE_DECISION` |
| **Answer A vs B** | **A** | **A** (earnings in DB; **not** B) |

---

## 5. Answer to audit objective (A vs B)

| Payout | A — Earnings in reconstructed wallet | B — Pre-reset deleted earnings |
|--------|----------------------------------------|--------------------------------|
| **£16.93** | **Yes** — 100% of payout amount is live `TRIP_EARNING_NET` still in wallet | **No** |
| **£56.41** | **Partially** — all trips in DB; **4,201p** wallet-backed; **1,440p** banked after reversal | **No** |

**Neither payout is attributable to the 2026-06-01 ledger wipe.** Both are **post-reset auto Connect sweeps** missing payout ledger debits.

The MK0002 **£27.40 gap** (5,641p paid − 1,901p wallet) is explained by:

1. **£14.40** — transfers on **reversed** trips (zero wallet)  
2. **£12.99** — remaining card trip (`7e4b6246`, 408p) still in wallet, not in sweep  
3. **Cash / debt / tip netting** — global ledger entries (e.g. `DRIVER_TIP_CREDIT` +100p, debt cycle net 0)  

---

## 6. Classification matrix (all orphan Connect payouts)

| Stripe payout | Amount | Class | Execute backfill? |
|---------------|-------:|-------|-------------------|
| `po_1TjTPX…` MK0001 | 1,693p | **`SAFE_LEDGER_BACKFILL`** | Yes — after 3C.4 wallet deploy |
| `po_1TjUCp…` MK0002 | 5,641p | **`REQUIRES_FINANCE_DECISION`** | Only after finance picks Option 1–3 (§3.5) |
| `po_1Tjb00…` MK0001 | 457p | Already debited (`MANUAL_PAYOUT`) | Link `payout_item` only (3C.5) |

**`PRE_RESET_HISTORY`** applies only to **legacy** payouts on deleted driver `58b29f86-…` (`po_1TgwCx` £41.16, `po_1Tffdp` £7.77) — **out of scope** for these two orphans.

---

## 7. GO / NO-GO — remediation by classification

| Action | GO? |
|--------|-----|
| MK0001 `po_1TjTPX` **−1,693p** backfill | **GO** (conditional on 3C.4 + idempotent RPC dry-run) |
| MK0002 `po_1TjUCp` full **−5,641p** backfill | **NO-GO** without finance sign-off |
| MK0002 partial / split remediation | **NO-GO** until Option 1–3 decided |
| Treat either as `PRE_RESET_HISTORY` | **NO-GO** — evidence contradicts |

---

## 8. References

- `docs/PHASE_3C5_HISTORICAL_PAYOUT_REMEDIATION_AUDIT.md`
- `docs/PHASE_3C4_STRIPE_RECONCILIATION_AUDIT.md`
- `docs/test-day-reset-report.md`
- `supabase/migrations/20260715120000_p0_finance_ledger_ssot.sql` — `LEDGER_REVERSAL` backfill
- Prod attribution run 2026-06-18 (ledger + transfer 1:1 match on `TRIP_EARNING_NET`)
