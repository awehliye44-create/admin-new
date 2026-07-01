# Weekly Payout / Settlement Eligibility Audit

**Date:** 2026-06-25  
**Scope:** Read-only audit — no code changes, no deploy  
**Prod project:** `thazislrdkjpvvghtvzo`  
**Stripe context:** T+3 platform settlement · Separate Charges and Transfers · Express Connect delay · Instant Payouts not enabled

---

## Executive summary

ONECAB **does not select individual trips** for weekly driver payout. Weekly Monday settlement pays **`max(lifetime wallet ledger balance, 0)`** per driver, gated by Financial Reconciliation SSOT and a **binary** Stripe platform balance check (`provider_allocated > 0`).

**Reporting week and payout eligibility are not separated.** Trip `completed_at` week boundaries apply only to **Financial Reconciliation page display** and a **weekly cash-collected UI stat** — not to the payout engine.

**Per-trip Stripe settlement timing is not enforced** for weekly payout. Card earnings enter the wallet ledger at **trip completion / capture**, before Stripe `balance.available` / `available_on` settlement. The payout engine does **not** cap payout amount to settled Stripe cash.

**Final verdict: UNSAFE WITH CLARITY GAPS**

The system can block payout when platform `available = 0` (protecting Case 1 for drivers with no prior settled float), but it **cannot guarantee** Case 1–4 when wallet balance mixes settled and unsettled card earnings. Naming (`WEEKLY_MONDAY`), UI week filters, and driver wallet copy imply week-based / “ready” payout more than the engine delivers.

---

## 1. Current payout selection logic

### Pipeline (two stages)

| Stage | Function | What it does |
|-------|----------|--------------|
| Batch creation | `admin-weekly-monday-settlement` | Creates `payout_batches` + `payout_items` (DB only) |
| Execution | `admin-driver-payout` | Stripe platform → Connect transfer (+ optional Connect → bank payout), ledger debit |

**Primary SSOT paths:**  
`admin-new/supabase/functions/admin-weekly-monday-settlement/index.ts`  
`admin-new/supabase/functions/admin-driver-payout/index.ts`  
`admin-new/supabase/functions/_shared/perDriverFinancialReconciliation.ts`  
`admin-new/supabase/functions/_shared/payoutAvailability.ts`

### Payable amount formula

```text
wallet_balance     = SUM(driver_wallet_ledger) excluding PLATFORM_COMMISSION, CASH_TRIP_EARNING
available_payout   = max(wallet_balance, 0)
payout_amount      = available_payout   (full wallet, not a trip subset)
```

Comment in code (`perDriverFinancialReconciliation.ts` ~196–197):

> *SSOT: available_payout = max(wallet_balance, 0). No provider cap, no in-flight cap.*

Ledger is **always lifetime** for payout guards:

> *Wallet balance / payout guard MUST use full lifetime ledger — never period-filtered.*

### What is NOT used for weekly payout selection

| Criterion | Used? |
|-----------|-------|
| `trips.started_at` | No |
| `trips.completed_at` week window | No (only optional `periodFrom`/`periodTo` when passed — settlement never passes them) |
| `payments.captured_at` | No |
| `driver_wallet_ledger.created_at` week | No for payout (only `isInCurrentLondonPayoutWeek` for **Weekly Cash Collected** display stat) |
| Per-trip Stripe `balance_transaction.available_on` | No in admin payout path (deprecated comment in `driverWalletSummary.ts`; early cashout enriches payout_items but admin weekly does not) |
| `payout_items` trip linkage | Items are per **driver**, not per trip |
| `trips.classification` / previous-week label | **Not referenced** in payout edge functions |

---

## 2. Answers to audit questions

### Q1. Does weekly payout select trips by…?

| Source | Answer |
|--------|--------|
| Trip `started_at` | **No** |
| Trip `completed_at` | **No** (trips loaded for reconciliation only; no week filter at settlement) |
| Payment `captured_at` | **No** |
| Ledger `created_at` | **No** for eligibility (lifetime ledger sum) |
| Stripe settlement availability | **Partially** — hard block only if allocated platform balance ≤ 0 |
| Wallet balance | **Yes — primary driver amount** |
| Financial Reconciliation available amount | **Same as wallet** (`driver_available_now_pence = max(wallet, 0)`) |

### Q2. Trip starts Sunday 23:00, completes Monday 00:30 — which payout week?

**Payout engine:** No “payout week” concept. The trip affects payout when:

1. **Ledger** — `TRIP_EARNING_NET` inserted at card capture / trip finalization (typically Monday ~00:31), increasing **lifetime** wallet immediately.
2. **Weekly batch** — next Monday settlement includes that balance if gates pass, **not** because it “belongs to” Sunday or Monday reporting week.

**Reporting only:**

- Financial Reconciliation page filters trips by `completed_at` in selected period (`admin-finance-reconciliation/index.ts`).
- `isInCurrentLondonPayoutWeek(ledger.created_at)` (`driverWalletSummary.ts`) — **display stat only** (“Weekly Cash Collected”), not payout.

### Q3. Payment captured Sunday, Stripe settles Wed/Thu — can Monday payout include it?

**Yes, if gates pass:**

- Ledger credits on capture → wallet includes earnings **before** Stripe platform `available` settles.
- If platform `balance.available > 0` (from any source), `providerAllocatedPence > 0` → driver **not blocked**.
- Payout amount = **full wallet**, not `min(wallet, settled)`.

If platform `available = 0` at Monday run → hard block: *"No provider balance allocated — funds awaiting settlement"*.

**Gap:** Mixed wallet (old settled + new unsettled) can attempt payout of **full wallet** while only part is settled on Stripe.

### Q4. Does payout engine check Stripe available balance before payout?

**Yes — aggregate platform balance only:**

```typescript
// admin-weekly-monday-settlement / admin-driver-payout
stripe.balance.retrieve() → balance.available (GBP)
```

Allocated per driver via `allocateProviderBalanceByLiability()` (pro-rata by region ledger liability; **single driver in region → 100% of platform available**).

**Does not read:**

- Connect `balance.available` / `instant_available` for weekly execution
- Per-charge `available_on`
- `balance.pending` as a hard gate (pending is passed to SSOT but not used to block payout amount)

### Q5. Does payout engine check Financial Reconciliation status before payout?

**Yes.** `fetchPerDriverFinancialReconciliation` → `buildPayoutGateReasons()`:

| Hard block | Condition |
|------------|-----------|
| Negative wallet | `wallet_balance < 0` |
| Reconciliation mismatch | Variance > £1 tolerance (hard unless MK soft-classified) |
| Reconstructed tier | `sourceTier === RECONSTRUCTED` |
| Ledger sync missing | Prior completed payout without ledger debit |
| No provider allocation | `providerAllocatedPence <= 0` |
| Zero available | `availableNow <= 0` (wallet ≥ 0) |

**Soft warning (admin-new):** MK region positive variance may still create `payout_item` with warning.

**admin-finance-reconciliation page:** Period-scoped **display/audit only** — does not drive weekly engine.

### Q6. Does payout engine prevent paying unsettled card money?

**Partially, not per-trip.**

- Uncaptured / failed card: phantom `TRIP_EARNING_NET` excluded in **driver wallet UI** via `filterLedgerForWalletBalance` — **admin payout uses full ledger**, not this filter.
- Unsettled but **captured** card: **included in wallet and payable** once platform `available > 0`.
- No `min(wallet, stripe_settled_for_driver)` on payout amount.

### Q7. Are cash trips handled separately from card trips?

**Yes.**

| Aspect | Card | Cash |
|--------|------|------|
| Digital reconciliation trips | Included (`filterDigitalTrips` excludes cash) | Excluded from digital revenue identity |
| Wallet ledger | `TRIP_EARNING_NET`, `DRIVER_TIP_CREDIT` count toward balance | `CASH_TRIP_EARNING` **excluded** from wallet balance (reporting-only); `CASH_COMMISSION_DEBT` reduces wallet |
| Stripe weekly payout | Eligible via wallet balance (card earnings) | Cash fare **not** paid through Stripe weekly transfer |
| Ledger creation | `stop-workflow` / `finalize-trip-and-capture` → `TRIP_EARNING_NET` | `CASH_COMMISSION_DEBT`, `CASH_TRIP_EARNING` (reporting) |

### Q8. Are cash fares excluded from Stripe revenue and card payout liability?

**Yes for reconciliation LHS/RHS digital identity.** Cash passenger revenue is excluded from digital net customer revenue. Cash commission debt is tracked via ledger, not Stripe card payout liability.

### Q9. Does transfer creation use `source_transaction` as Stripe recommends?

| Flow | `source_transaction`? | File |
|------|----------------------|------|
| **Trip capture (SCT driver transfer)** | **Yes** — `source_transaction: chargeId` | `admin-new/supabase/functions/_shared/stripeSettlement.ts` ~191–206 |
| **Weekly / manual admin payout** | **No** | `admin-driver-payout/index.ts` ~645–655 |
| **Early cashout top-up transfer** | **No** | `driver-early-cashout/index.ts` |

Trip capture uses `settlement_mode: 'separate_charge_transfer'`.

### Q10. If not using `source_transaction` on weekly payout — why?

Weekly/manual payout moves a **lump sum** from **platform balance → Connect** based on **wallet ledger liability**, not tied to individual charges. Per-trip fund routing is intended to happen at **capture** via `stripeSettlement.ts`. Weekly transfer metadata: `payout_item_id`, `driver_id`, `batch_id` only.

**Architectural note:** Under SCT, driver share should already reach Connect at capture. A second platform→Connect transfer for the same wallet liability risks **double-funding** unless ledger debits and capture transfers are strictly reconciled. This audit does not re-prove cash-flow correctness end-to-end; it flags the **eligibility model** does not tie weekly amount to per-trip Connect balances.

---

## 3. Flow-by-flow notes

### `admin-weekly-monday-settlement`

- Drivers: `approval_status = 'approved'`
- Amount: `ssot.driver_available_now_pence` (full wallet)
- Creates `payout_batches.kind = WEEKLY_MONDAY`, `payout_items.status = pending`, `settlement_status = READY`
- **No Stripe execution**, no ledger debit
- `run_date` = UTC date of invocation (metadata only)

### `admin-driver-payout`

- Re-runs SSOT gates at execution
- `payoutAmount = amount_pence || ssot.driver_available_now_pence`
- `evaluatePayoutGuard()` — wallet negative; requested > available
- `stripe.transfers.create` from **platform** to Connect — **no `source_transaction`**
- Optional `stripe.payouts.create` on Connect account
- Success → `WEEKLY_PAYOUT` ledger debit via `payoutLedgerSync.ts`

### `driver-early-cashout`

- Separate path; service-area + platform instant gates (recent)
- Uses finance SSOT + payout item `available_on` enrichment for driver UI
- **Not** weekly batch; same wallet / provider allocation concepts apply

### `finance-reconciliation-driver`

- Driver-facing overlay; separates ledger vs Stripe standard/instant (recent clarity work)
- **Does not** drive admin weekly selection

### `driver_wallet_ledger`

- Card: `TRIP_EARNING_NET` at trip end/capture (`stop-workflow` skips card ledger when Stripe PI — finalized elsewhere)
- Cash: `CASH_COMMISSION_DEBT` (wallet), `CASH_TRIP_EARNING` (excluded from balance)
- Payout debits: `WEEKLY_PAYOUT`, `EARLY_CASHOUT`, `MANUAL_PAYOUT`

### `payout_batches` / `payout_items`

- Batch = run metadata; items = **per driver**, not per trip
- Status flow: `pending` → `processing` → `completed` / `failed` / `ledger_sync_failed`
- No trip_id on standard weekly item amount calculation

---

## 4. Edge case analysis

### Case 1 — Sun 23:00 start, Mon 00:30 complete, card captured Mon 00:31, Stripe settles Thu

| Expected | Current behaviour |
|----------|-------------------|
| Not paid Mon 08:00; eligible after settlement | **Depends.** If platform `available = 0` → **blocked** (good). If platform has float from other trips → **may pay full wallet including unsettled trip** (bad). Ledger credits Mon 00:31 regardless of Stripe. |

### Case 2 — Sun 20:00 complete, captured Sun 20:01, Stripe settles Wed

| Expected | Not paid Mon if unsettled |
|----------| Same as Case 1 — **not guaranteed**; wallet includes trip immediately; Monday payout if `providerAllocated > 0`. |

### Case 3 — Cash trip Sunday night

| Expected | Cash not paid via Stripe |
|----------| **Correct** — cash fare not in wallet balance; commission via `CASH_COMMISSION_DEBT`; no card Stripe payout for fare. |

### Case 4 — Card Tue complete, Stripe settled Fri, Monday after settlement

| Expected | Eligible next Monday if balanced |
|----------| **Eligible whenever wallet > 0 and gates pass** — not “next Monday after settlement” as explicit rule; may have been eligible earlier if platform had balance. |

---

## 5. Reporting week vs payout eligibility (gap analysis)

| Safe business rule | Current state |
|--------------------|---------------|
| **A. Reporting week** for KPIs / commissions | FR page uses `completed_at` period filters ✓ |
| **B. Payout eligibility** requires completion + capture + ledger + FR balanced + **Stripe settled** + not paid + no debt | **Partial** — completion/capture/ledger/FR/debt checked; **per-trip Stripe settlement not required**; **not paid** via ledger debits; **week membership irrelevant** |

**Critical gap:** A trip must not be paid *because it belongs to a previous reporting week* — **currently moot** because no trip-week selection exists; instead, **all lifetime wallet** is paid, which is a different risk.

---

## 6. Risks found

| ID | Severity | Risk |
|----|----------|------|
| R1 | **High** | Payout amount = full wallet, not capped to Stripe settled / allocated cash |
| R2 | **High** | Ledger credits at capture, not at Stripe `available_on` (T+3 mismatch) |
| R3 | **Medium** | Provider gate is binary (`allocated > 0`), not `allocated >= payout_amount` |
| R4 | **Medium** | “Weekly Monday” naming implies week-scoped payout; engine is cumulative wallet |
| R5 | **Medium** | FR period filters and trip tables imply week-based liability; payout ignores them |
| R6 | **Low** | `trips.classification` in DB unused by payout — previous-week audit concern does not apply to engine, but ops may assume it does |
| R7 | **Low** | Weekly transfer without `source_transaction` — acceptable for aggregate payout if capture transfers are correct; otherwise reconciliation drift |
| R8 | **Info** | drive-hub-buddy `admin-driver-payout` lacks admin-new execution gates (`confirm_payout`, `ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED`) — prod should use admin-new SSOT |

---

## 7. Recommended payout policy (no implementation)

1. **Split reporting week vs payout eligibility explicitly** in code and admin UI copy.
2. **Payout eligibility amount** = `min(wallet_balance, finance_cleared, stripe_platform_available_allocated, connect_settled_cap)` — not lifetime wallet alone.
3. **Per-trip eligibility flags** (or rolling settled pool): card trip payable only when capture confirmed **and** Stripe `available_on <= now` (or Connect balance evidence).
4. **Never pay** ledger rows for trips whose charges are still in platform `pending` unless covered by `source_transaction` transfer to Connect with verified available balance.
5. **Weekly batch** should store `eligible_amount_pence` vs `wallet_balance_pence` for audit.
6. Keep **cash** off Stripe payout paths; keep **SCT `source_transaction`** at capture.
7. When Instant Payouts enabled, instant cap remains separate from weekly scheduled cap.

---

## 8. Acceptance tests (for future implementation)

1. Sun→Mon trip, capture Mon, Stripe unsettled Thu → **Mon weekly run: £0 executable**, wallet still shows earned.
2. Same trip Thu after settlement → eligible amount increases; Mon **next** run can pay only settled portion.
3. Wallet £9.73, Stripe available £4.08 → payout offer **£4.08**, not £9.73.
4. Cash trip → zero Stripe payout; commission debt only.
5. FR mismatch hard block → no `payout_item` / no transfer.
6. Platform `available = 0` → all drivers blocked with awaiting-settlement reason.
7. Already `WEEKLY_PAYOUT` debited trip → not double-paid.
8. Reporting week filter on FR page unchanged; payout eligibility independent.

---

## 9. Key file index

| File | Role |
|------|------|
| `admin-new/supabase/functions/admin-weekly-monday-settlement/index.ts` | Batch + item creation |
| `admin-new/supabase/functions/admin-driver-payout/index.ts` | Stripe transfer + ledger debit |
| `admin-new/supabase/functions/_shared/perDriverFinancialReconciliation.ts` | SSOT fetch, trip/ledger queries, gates |
| `admin-new/supabase/functions/_shared/payoutAvailability.ts` | `max(wallet, 0)` formula |
| `admin-new/supabase/functions/_shared/financialReconciliationSSOT.ts` | Digital reconciliation, allocation |
| `admin-new/supabase/functions/_shared/stripeSettlement.ts` | Capture transfer + `source_transaction` |
| `admin-new/supabase/functions/_shared/payoutLedgerSync.ts` | Post-success ledger debit |
| `admin-new/supabase/functions/admin-finance-reconciliation/index.ts` | Period-scoped FR **display** |
| `drive-hub-buddy/supabase/functions/stop-workflow/index.ts` | Cash/card ledger at trip end |
| `drive-hub-buddy/shared/driverWalletSummary.ts` | London payout week helper (display only) |
| `drive-hub-buddy/supabase/functions/finance-reconciliation-driver/index.ts` | Driver SSOT overlay |
| `drive-hub-buddy/supabase/functions/driver-early-cashout/index.ts` | Instant path (separate) |

---

## 10. Final verdict

### **UNSAFE WITH CLARITY GAPS**

**Why not SAFE:** Payout eligibility is wallet-lifetime-based, ledger credits precede Stripe settlement, and payout amount is not capped to settled Stripe cash — violating the stated safe rule for T+3 Separate Charges and Transfers.

**Why not fully UNSAFE:** Aggregate block when platform `available = 0`, Financial Reconciliation hard gates, negative wallet block, and Stripe API failure at transfer time provide partial protection.

**Why not BLOCKED:** Weekly payout pipeline is operational; issue is **policy/model mismatch**, not missing implementation.

**Do not change code until product/finance sign-off on recommended policy (Section 7).**
