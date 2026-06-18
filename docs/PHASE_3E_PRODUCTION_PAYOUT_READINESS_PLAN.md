# Phase 3E — Production Payout Operations Readiness Plan

**Date:** 2026-06-18  
**Project:** `thazislrdkjpvvghtvzo` (prod)  
**Region:** MK (`7f611e59-a9e5-42c2-b65a-61376910bb5d`)  
**Starting point:** Phase 3D.4 Finance Closure = **PASS**  
**Current payout state:** Investigation complete — **first controlled live payout = NO-GO**  
**This document:** Planning and operational readiness only — **no code, Stripe, ledger, or deployment changes**

---

## Executive summary

Phase 3D closed the finance investigation loop: wallet SSOT is consistent, reconciliation endpoints work, Connect auto-payout is locked down, and payout execution is gated. Phase 3E moves ONECAB from **investigation mode** to **production operations mode** by defining governance, runbooks, monitoring, dashboard requirements, live-payout gates, and rollback procedures.

**Current prod snapshot (2026-06-18):**

| Signal | Value |
|--------|-------|
| MK0001 wallet (ledger SSOT) | **−£2.78** |
| MK0002 wallet (ledger SSOT) | **−£23.00** |
| Region Driver Available Now | **£0.00** |
| Region Remaining Liability | **£0.00** (finance card layer differs per driver) |
| Platform Provider Available | **£6.66** |
| `ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED` | **false** |
| Connect payout schedule (MK0001, MK0002) | **manual** |
| In-flight Connect payout | `po_1TjdXr…` £2.78 pending (MK0001, ledger-linked) |

**Phase 3E outcome:** When implemented, ops can run payouts with defined approvals, verification, monitoring, and recovery — without repeating Phase 3D orphan/incident patterns.

**Related artifacts:**

- [`PHASE_3D4_FINANCE_CLOSURE_FINAL_VERIFICATION.md`](PHASE_3D4_FINANCE_CLOSURE_FINAL_VERIFICATION.md)
- [`PHASE_3D3_CONNECT_AUTO_PAYOUT_LOCKDOWN_REPORT.md`](PHASE_3D3_CONNECT_AUTO_PAYOUT_LOCKDOWN_REPORT.md)
- [`PHASE_3D1_PAYOUT_SAFETY_LOCKDOWN_REPORT.md`](PHASE_3D1_PAYOUT_SAFETY_LOCKDOWN_REPORT.md)

---

## 1. Payout Governance Model

### 1.1 Roles and responsibilities

| Role | System identity | Can approve payout policy | Can execute payout | Can toggle execution secret |
|------|-----------------|---------------------------|--------------------|-----------------------------|
| **Business owner (Ahmed)** | Named approver (out of band) | **Yes** — sole authority for first live payout and execution enablement | No (recommended) | **Yes** — explicit sign-off required |
| **Super Admin** | `staff_profiles.role = super_admin` | Yes — operational policy within Ahmed mandate | Yes — with `confirm_payout` | Yes — Supabase secret management |
| **Finance Manager** | `finance_manager` | Yes — per-run review sign-off | Yes — with `confirm_payout` | No |
| **Admin / Operator** | `admin`, `operator` with `payout-batches` + `admin-settlements` page access | No | No — view and simulate only | No |
| **Compliance / Audit** | `compliance_officer` (read-only finance pages) | No | No | No |

**Separation of duties (recommended minimum):**

1. **Policy approval** (Ahmed) ≠ **execution enablement** (Super Admin sets secret after Ahmed approval) ≠ **payout execution** (Finance Manager or Super Admin invokes with `confirm_payout: true`).
2. The operator who runs `verification_mode` dry-runs should not be the sole approver for the subsequent live run (four-eyes where staffing allows).
3. Connect schedule changes (`admin-connect-payout-lockdown`) require Super Admin or Finance Manager; never revert Connect to automatic without Ahmed approval.

### 1.2 Approval workflow

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. PRE-RUN REVIEW (Finance Manager)                             │
│    • Run read-only audits (3D.4 script / dashboard)             │
│    • Confirm driver eligibility, reconciliation, Stripe cash    │
│    • Document sign-off in payout run log (ticket / spreadsheet) │
└────────────────────────────┬────────────────────────────────────┘
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ 2. BUSINESS APPROVAL (Ahmed) — required for:                    │
│    • First ever live payout                                     │
│    • Setting ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED=true         │
│    • Any payout while driver wallet is negative                 │
│    • Any payout with RECONCILIATION_MISMATCH (normally blocked) │
└────────────────────────────┬────────────────────────────────────┘
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ 3. SIMULATION (Executor)                                        │
│    • admin-driver-payout { verification_mode: true }            │
│    • admin-weekly-monday-settlement { verification_mode: true } │
│    • Confirm zero batches/items/ledger/Stripe side effects      │
└────────────────────────────┬────────────────────────────────────┘
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ 4. EXECUTION ENABLE (Super Admin — one-time or time-boxed)      │
│    • ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED=true                 │
│    • Record timestamp + approver in ops log                     │
└────────────────────────────┬────────────────────────────────────┘
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ 5. LIVE RUN (Finance Manager / Super Admin)                     │
│    • confirm_payout: true (manual) or weekly batch confirm      │
│    • Single driver first (MK region staged rollout)             │
└────────────────────────────┬────────────────────────────────────┘
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ 6. POST-RUN VERIFICATION + DISABLE (recommended)                │
│    • Ledger / Stripe / payout_item cross-check                  │
│    • Set ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED=false            │
└─────────────────────────────────────────────────────────────────┘
```

### 1.3 Audit trail requirements

Every payout operation must be reconstructable from persisted records. Required audit sources:

| Layer | Table / artifact | What it proves |
|-------|------------------|----------------|
| Batch | `payout_batches` | Who initiated (`created_by`), kind, run_date, status, failure_code |
| Item | `payout_items` | Per-driver amount, Stripe IDs, settlement snapshot, status |
| Ledger | `driver_wallet_ledger` | Wallet debit/credit, `stripe_transfer_id`, `stripe_payout_id` |
| Connect lockdown | `stripe_connect_payout_schedule_audit` | Schedule was manual at time of ops |
| Staff actions | Staff audit log (`roles.staff.*` events) | Role changes, access |
| Edge logs | Supabase function logs | `[payout]` transfer/payout IDs, errors |
| External | Stripe Dashboard | `tr_…`, `po_…` immutable payment records |

**Minimum fields for manual ops log (spreadsheet or ticket):**

- Date/time UTC, operator email, approver (Ahmed Y/N), driver code, amount, verification_mode run ID/timestamp, live batch/item IDs, Stripe transfer/payout IDs, post-run wallet balance, pass/fail.

**Retention:** Indefinite for payout_batches, payout_items, ledger rows; 7 years for finance compliance (align with invoice retention policy).

---

## 2. First Controlled Payout Checklist

Use this checklist for the **first live driver payout** in MK region. Do not skip steps.

### 2.1 Before payout

| # | Check | How | Pass criteria | Current (2026-06-18) |
|---|-------|-----|---------------|----------------------|
| B1 | Finance closure | `npx tsx scripts/phase3d4-finance-closure-verification.ts` | All 9 sections PASS | ✅ PASS |
| B2 | Execution gate | Supabase secret | `ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED=false` until gate cleared | ❌ Still false (expected) |
| B3 | Ahmed approval | Out-of-band sign-off | Written approval for first live payout + amount + driver | ❌ Pending |
| B4 | Connect lockdown | `/connect-payout-lockdown` or `admin-connect-payout-status` | `automatic_count: 0`, schedule `manual` | ✅ PASS |
| B5 | Reconciliation status | `admin-finance-reconciliation?driver_id=…` | Target driver `reconciliation_status != RECONCILIATION_MISMATCH` OR explicit Ahmed override | ❌ MK0002 blocked; MK0001 BALANCED |
| B6 | Wallet status | Driver Wallet page / ledger sum | Understand negative wallet; no surprise debits | ⚠️ MK0001 −£2.78 (incident B debit) |
| B7 | Driver liability (finance SSOT) | Per-driver finance panel | `driver_available_now_pence > 0` | ❌ Region £0.00; per-driver may show allocation but wallet negative |
| B8 | No in-flight payout | `admin-connect-payout-status` + payout_items | No pending item for target driver OR documented completion | ⚠️ MK0001 `po_1TjdXr` pending |
| B9 | Stripe platform cash | Financial Reconciliation / Stripe | Provider available ≥ payout amount | ⚠️ £6.66 platform (Connect separate) |
| B10 | Stripe Connect balance | Connect status panel | Sufficient Connect available if using transfer→payout path | MK0001 £0.87 avail + £9.54 pending |
| B11 | Orphan scan | `stripe-reconciliation-audit` (read-only) | No new unpaid Connect payouts without ledger | ✅ Historical documented |
| B12 | Payout simulation | `admin-driver-payout { verification_mode: true }` | 200, `payout_safety_version: 3d.1`, no batch/item IDs | ✅ PASS |
| B13 | Weekly simulation | `admin-weekly-monday-settlement { verification_mode: true }` | 200, `batch_id: null`, zero side effects | ✅ PASS |
| B14 | Negative wallet policy | Ahmed decision | Explicit approval if wallet < 0 | ❌ Required for MK0001 |

**Gate:** All B-rows must be ✅ or explicitly waived by Ahmed in writing before proceeding.

### 2.2 During payout

| # | Step | Requirement |
|---|------|---------------|
| D1 | Enable execution | Super Admin sets `ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED=true` (time-boxed) |
| D2 | Select driver | Start with **one** driver — recommend first eligible driver with positive `driver_available_now_pence` and non-negative wallet after in-flight clears |
| D3 | UI confirmation | `ManualPayoutConfirmDialog` — operator checks amount, SSOT, warnings checkbox |
| D4 | API confirmation | Request body **must** include `confirm_payout: true` |
| D5 | Amount cap | `payoutAmount ≤ ssot.driver_available_now_pence` (server enforced) |
| D6 | Monitor live | Watch Supabase function logs for `[payout] Transfer created` / `Bank payout created` |

**Expected DB writes (successful manual payout):**

| Order | Object | Typical values |
|-------|--------|----------------|
| 1 | `payout_batches` | New row, kind `MANUAL_ADMIN`, status progresses CREATED → READY → completed/failed |
| 2 | `payout_items` | New row linked to batch, `net_driver_payout_pence`, settlement snapshot |
| 3 | `driver_wallet_ledger` | `PAYOUT_CREATED` (0p marker), then `MANUAL_PAYOUT` debit (−amount) on success |
| 4 | `driver_wallets` / `driver_financial_summary` | Recalculated via `recalculate_driver_wallet` |

**Expected Stripe objects (Connect manual path):**

| Order | Object | Account | Idempotency |
|-------|--------|---------|-------------|
| 1 | **Transfer** `tr_…` | Platform → Connect | `payout_{payout_item_id}` |
| 2 | **Payout** `po_…` | Connect → driver bank | `payout_{payout_item_id}_payout` |

### 2.3 After payout

| # | Check | How | Pass criteria |
|---|-------|-----|---------------|
| A1 | Payout item status | `payout_items` / Admin Payout Batches | `completed`, Stripe IDs populated |
| A2 | Ledger debit | Driver Wallet ledger | `MANUAL_PAYOUT` row with matching `stripe_payout_id`, amount = −net paid |
| A3 | Wallet recalc | Ledger SSOT sum = admin summary = driver app | All three match |
| A4 | Stripe reconciliation | Stripe Dashboard + optional `stripe-reconciliation-audit` | Transfer + payout amounts match item |
| A5 | No orphan | `admin-connect-payout-status` | `orphan_risk: false` on new payout |
| A6 | Batch totals | `payout_batches.total_amount_pence` | Matches sum of completed items |
| A7 | Re-run 3D.4 script | Read-only verification | No regressions; document new state |
| A8 | Disable execution | Supabase secret | Set `ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED=false` |
| A9 | Ops log | Ticket / spreadsheet | Complete audit record |

---

## 3. Payout Runbook

### 3.1 Manual driver payout

**Entry points:** Admin → Driver Settlements → Pay Driver Now, or direct invoke `admin-driver-payout`.

**Preconditions:**

- Driver: `stripe_account_id` set, `onboarding_complete`, `payouts_enabled`
- SSOT: `driver_available_now_pence > 0`, `payout_blocked = false`, no in-flight payout item
- Gates: `ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED=true`, `confirm_payout: true`

**Procedure:**

1. Open driver in **Driver Settlements** — review SSOT panel (available now, warnings, blocked reasons).
2. Run **verification_mode** invoke (or use UI dry-run if exposed) — confirm eligibility message.
3. Obtain approver sign-off if soft warnings present (`payout_warning_reasons`).
4. Click **Pay Driver Now** → confirm dialog → submits with `confirm_payout: true`.
5. On success: note `batchId`, `payoutItemId`, `stripeTransferId`, `stripePayoutId`, `ledgerEntryId`.
6. On failure: see §7 Rollback — do not retry without understanding failure class.

**Hard blocks (server — do not override without code change):**

- `MANUAL_PAYOUT_BLOCKED` — reconciliation hold
- `MANUAL_PAYOUT_NO_SSOT_BALANCE` — available now ≤ 0
- `PAYOUT_IN_FLIGHT` — existing pending/processing item
- `ADMIN_PAYOUT_EXECUTION_DISABLED` — secret false
- `MANUAL_PAYOUT_CONFIRMATION_REQUIRED` — missing `confirm_payout`

### 3.2 Weekly payout batch

**Entry point:** Admin → Driver Settlements → Weekly Monday Settlement panel, or `admin-weekly-monday-settlement`.

**Behaviour:**

- Creates `payout_batches` kind `WEEKLY_MONDAY` + one `payout_items` row per eligible driver
- Skips hard-blocked drivers; includes soft-warning drivers
- Does **not** execute Stripe in batch creation phase — execution is separate driver payout path or future batch processor

**Procedure:**

1. **Monday pre-check:** Run `admin-monday-payout-diagnostics?region_id=MK&today=false` — review READY vs BLOCKED vs MISMATCH.
2. Run `{ verification_mode: true }` — confirm no batch created, review simulated driver list.
3. Enable execution secret (time-boxed).
4. Invoke without verification_mode — creates batch + items only (weekly v6 still requires execution enabled for batch creation).
5. For each READY item: execute payout via linked manual path or batch execution workflow (as implemented).
6. Verify batch status transitions; failed items remain for retry.

**Do not run weekly batch while:**

- Orphan weekly artifacts exist in READY/pending state
- Region reconciliation FAILED (not just soft warnings)
- Connect automatic schedule detected on any driver

### 3.3 Payout retry

**Two retry classes:**

| Class | Symptom | Action |
|-------|---------|--------|
| **Ledger sync retry** | Stripe transfer/payout succeeded; ledger debit missing | `admin-sync-payout-ledger` with `payout_item_id` — sync only, no new Stripe |
| **Full provider retry** | Transfer failed; item has no `stripe_transfer_id` | `admin-driver-payout` with `retry_payout_item_id` + `confirm_payout: true` |

**Rules:**

- Never retry if item already has `stripe_transfer_id` — use ledger sync only
- Never retry without checking in-flight status
- Idempotency keys prevent duplicate transfers for same `payout_item_id`

### 3.4 Payout cancellation

**Stripe reality:** Connect payouts in `pending` / `in_transit` generally **cannot** be cancelled. ONECAB policy:

| Scenario | Action |
|----------|--------|
| Batch/item created but Stripe not called | Mark item `failed` / `FAILED_DUPLICATE`; zero amounts if orphan (see 3D.1 migration pattern) |
| Stripe transfer failed | Automatic wallet return via `recordPayoutFailureAndReturnToWallet` |
| Stripe payout pending (manual) | **Monitor to completion** — do not create second payout; ledger already debited if finalize ran |
| Duplicate weekly item | Set `FAILED_DUPLICATE`, link failure_code, zero amount |

**Never** delete ledger rows. Reversal uses `LEDGER_REVERSAL` type only with finance approval.

### 3.5 Payout failure recovery

| Failure mode | System behaviour | Operator action |
|--------------|------------------|-----------------|
| Stripe transfer fails | Item failed, amount returned to wallet SSOT | Fix root cause (Connect, balance); retry with `retry_payout_item_id` |
| Transfer OK, payout create fails | Transfer ID stored; may need manual Connect payout | Finance review; may use Stripe Dashboard on Connect account (manual schedule) |
| Provider success, ledger fail | **CRITICAL** — `alert` in response | Immediate: `admin-sync-payout-ledger`; escalate if unresolved |
| Partial settlement (cash commission) | `PARTIAL_SETTLEMENT` status | Document in ops log; verify commission recovery rows |

---

## 4. Monitoring & Alerts

### 4.1 Alert catalogue

| Alert ID | Condition | Severity | Detection method | Response |
|----------|-----------|----------|------------------|----------|
| **MON-001** | Connect payout schedule ≠ `manual` | P0 | `admin-connect-payout-status` daily | Re-apply lockdown; investigate regression |
| **MON-002** | Stripe paid Connect payout without ledger debit | P0 | `stripe-reconciliation-audit` or orphan discover | Ledger backfill via approved RPC; no new auto payouts |
| **MON-003** | Ledger `MANUAL_PAYOUT`/`WEEKLY_PAYOUT` without `stripe_payout_id` | P1 | `finance-backend-audit-v1` | Investigate incomplete finalize |
| **MON-004** | `payout_items` completed but ledger amount mismatch | P1 | Cross-query item vs ledger | Sync or adjustment with approval |
| **MON-005** | `payout_items` pending > 24h with Stripe IDs | P1 | Admin Payout Batches | Check Stripe status; avoid duplicate retry |
| **MON-006** | Per-driver `RECONCILIATION_MISMATCH` | P1 | Finance reconciliation | Block payout; finance review |
| **MON-007** | Region reconciliation `balanced: false` | P2 | Daily finance summary | Ops review before batch run |
| **MON-008** | Unexpected Connect balance drop without payout_item | P1 | Compare Connect status snapshots | Check for manual Stripe action outside admin |
| **MON-009** | `ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED=true` outside window | P0 | Secret audit / scheduled check | Disable if unauthorized |
| **MON-010** | New `payout_batches` while verification script running | P0 | 3D.1/3D.4 delta checks | Incident response; disable execution |
| **MON-011** | Automatic Connect payout (`automatic: true`) in-flight post-lockdown | P0 | `admin-connect-payout-status` | Should be impossible — escalate immediately |
| **MON-012** | Wallet SSOT drift (ledger ≠ summary ≠ app) | P0 | 3D.4 section 1 | Stop payouts; run wallet integrity |

### 4.2 Monitoring schedule (recommended)

| Frequency | Job | Tool |
|-----------|-----|------|
| Daily 08:00 UTC | Full read-only finance closure | `phase3d4-finance-closure-verification.ts` |
| Daily 08:15 UTC | Connect lockdown status | `admin-connect-payout-status` |
| Weekly Monday 06:00 UTC | Pre-settlement diagnostics | `admin-monday-payout-diagnostics` |
| On-demand | Before any live payout | First Controlled Payout Checklist §2 |
| Monthly | Stripe deep reconciliation | `stripe-reconciliation-audit` |

### 4.3 Notification channels (to implement in 3E ops)

- **P0:** SMS/email to Ahmed + Super Admin
- **P1:** Slack/email to finance_manager
- **P2:** Dashboard badge only

---

## 5. Readiness Dashboard Specification

A single **Payout Operations** view (new page or consolidated Finance hub) — specification only; build in a future implementation phase.

### 5.1 Layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│  PAYOUT OPERATIONS READINESS                          Last sync: … UTC   │
├──────────────────────────────────────────────────────────────────────────┤
│  [Execution Gate: DISABLED ●]  [Connect: ALL MANUAL ●]  [Run Audit]    │
├──────────────────────┬──────────────────────┬────────────────────────────┤
│  Platform cash       │  Payout health       │  Reconciliation health     │
│  Available £6.66     │  Payable: 0          │  Region: BALANCED          │
│  Pending   £1.13     │  Blocked:  2         │  Mismatch drivers: 1       │
│  Future    £7.79     │  In-flight: 1        │  Variance: 100p            │
├──────────────────────┴──────────────────────┴────────────────────────────┤
│  PAYABLE DRIVERS (driver_available_now > 0, not blocked)                  │
│  ┌─────────┬──────────┬────────────┬─────────────┬─────────────────────┐ │
│  │ Code    │ Wallet   │ Avail now  │ Recon       │ Action              │ │
│  └─────────┴──────────┴────────────┴─────────────┴─────────────────────┘ │
├──────────────────────────────────────────────────────────────────────────┤
│  BLOCKED DRIVERS                          │  IN-FLIGHT PAYOUTS           │
│  MK0002 — RECONCILIATION_MISMATCH         │  MK0001 po_1TjdXr £2.78     │
│  MK0001 — wallet negative (warning)      │  pending · ledger linked     │
├──────────────────────────────────────────────────────────────────────────┤
│  RECENT PAYOUT ACTIVITY · RECENT AUDITS · ALERTS (MON-*)                 │
└──────────────────────────────────────────────────────────────────────────┘
```

### 5.2 Data sources (existing)

| Widget | Source | Endpoint / page |
|--------|--------|-----------------|
| Platform cash | Provider Available SSOT | `admin-finance-reconciliation` → `provider_money` |
| Payable / blocked drivers | Per-driver finance SSOT | `admin-finance-reconciliation?driver_id=` + `manualPayoutGate.ts` rules |
| In-flight payouts | Connect + DB | `admin-connect-payout-status` + `payout_items` pending/processing |
| Payout health | Batch/item aggregates | `admin-payout-batches` |
| Reconciliation health | Region check | `finance_reconciliation_summary.reconciliation_check` |
| Connect lockdown | Schedule audit | `admin-connect-payout-status` |
| Execution gate | Secret state | Display cached flag (read from dry-run response `stripe_execution_disabled`) |

### 5.3 Actions (read-only dashboard vs ops dashboard)

| Action | Permission | Notes |
|--------|------------|-------|
| Run read-only audit | Finance Manager+ | Invokes verification_mode only |
| Dry-run lockdown | Super Admin | Existing Connect page |
| Pay driver | Finance Manager+ | Links to Settlements with pre-selected driver |
| Enable execution | Super Admin | **Out of band** — Supabase secrets UI, not in-app toggle (prevent accidental enable) |

### 5.4 Mapping to current admin pages

| Requirement | Current page | Gap |
|-------------|--------------|-----|
| Payable drivers | Driver Settlements / SSOT panel | No region aggregate |
| Blocked drivers | Monday diagnostics | Not unified |
| Platform cash | Financial Reconciliation | Clear — keep |
| In-flight payouts | Connect Payout Lockdown | Partial |
| Payout health | Payout Batches & Audit | Add health summary card |
| Reconciliation | Financial Reconciliation | Clear — keep |

---

## 6. First Live Payout Gate

### 6.1 Gate definition

`ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED=true` may only be set when **all** mandatory criteria are satisfied and documented.

### 6.2 Mandatory criteria (GO/NO-GO)

| ID | Criterion | Current status | Required for GO |
|----|-----------|----------------|---------------|
| G1 | Phase 3D.4 all sections PASS | ✅ | ✅ |
| G2 | Ahmed written approval for first live payout | ❌ | ✅ |
| G3 | No pending orphan Connect payouts (`orphan_risk: true`) | ✅ | ✅ |
| G4 | No unresolved in-flight payout incidents | ⚠️ `po_1TjdXr` pending | ✅ — wait for paid or document |
| G5 | Target driver `driver_available_now_pence > 0` | ❌ Region £0 | ✅ |
| G6 | Target driver wallet ≥ 0 OR explicit Ahmed waiver | ❌ Both negative | ✅ or waiver |
| G7 | Target driver `payout_blocked = false` | ❌ MK0002 blocked | ✅ |
| G8 | Target driver `reconciliation_status = BALANCED` | ⚠️ MK0001 OK, MK0002 not | ✅ |
| G9 | Connect schedule manual on all drivers | ✅ | ✅ |
| G10 | `verification_mode` dry-run PASS immediately before live run | ✅ (re-run day-of) | ✅ |
| G11 | Platform + Connect cash ≥ payout amount | ⚠️ TBD per amount | ✅ |
| G12 | Operator + approver identified in ops log | — | ✅ |
| G13 | Rollback procedure acknowledged by operator | — | ✅ |
| G14 | Post-run verification script ready | ✅ | ✅ |

### 6.3 Recommended first payout candidate sequence

Given current state, recommended order:

1. **Wait** for `po_1TjdXr` (£2.78) to reach `paid` — verify wallet stable
2. **Resolve** MK0001 negative wallet (−£2.78) via adjustment or reconciliation sign-off
3. **First live candidate:** MK0001 when `driver_available_now_pence > 0`, wallet ≥ 0, BALANCED
4. **Exclude MK0002** until `RECONCILIATION_MISMATCH` cleared
5. **Smallest viable amount** — minimum £0.01 above block threshold; prefer full `driver_available_now_pence` only

### 6.4 Execution enablement protocol

```
1. Ahmed signs First Live Payout Authorization (driver, max amount, date window)
2. Super Admin verifies G1–G14 checklist
3. Super Admin sets ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED=true
4. Finance Manager executes single payout within 2-hour window
5. Post-run verification (§2.3)
6. Super Admin sets ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED=false
7. Retrospective note in PHASE_3E_LIVE_PAYOUT_REPORT.md (future deliverable)
```

**Standing rule:** Leave execution **disabled by default**. Treat enabled state as incident-prone configuration.

---

## 7. Rollback Procedure

### 7.1 Failure classification

| Class | Description | Reversible? |
|-------|-------------|-------------|
| **R1** | Pre-Stripe failure (validation, blocked) | N/A — no money moved |
| **R2** | Stripe transfer failed | Yes — wallet auto-returned |
| **R3** | Transfer OK, payout failed | Partial — funds on Connect |
| **R4** | Transfer + payout OK, ledger failed | **Critical** — money moved, ledger wrong |
| **R5** | Duplicate attempt | Prevented by idempotency + in-flight check |
| **R6** | Wrong amount paid | Not auto-reversible — manual Stripe + ledger adjustment |

### 7.2 R1 — Pre-Stripe failure

**Symptoms:** 400/403/409 response, no Stripe IDs on item.

**Recovery:**

1. No Stripe action required
2. If batch/item created in error: mark failed / `FAILED_DUPLICATE`, zero orphan amounts (3D.1 pattern)
3. Re-run verification_mode to confirm clean state

### 7.3 R2 — Stripe transfer failed

**Symptoms:** `stripeError` in response, `recordPayoutFailureAndReturnToWallet` called.

**Recovery:**

1. Confirm `returned_to_wallet_pence` in response
2. Verify wallet SSOT restored
3. Fix root cause (insufficient platform balance, Connect issue)
4. Retry with `retry_payout_item_id` + `confirm_payout: true`

### 7.4 R3 — Transfer OK, payout failed

**Symptoms:** `stripeTransferId` set, `stripePayoutId` null, Connect balance increased.

**Recovery:**

1. Do **not** create new transfer
2. With Connect manual schedule: create Connect payout via admin path or Stripe Dashboard (Finance approval)
3. Link `stripe_payout_id` on item
4. Run ledger sync if debit missing

### 7.5 R4 — Provider success, ledger sync failed (CRITICAL)

**Symptoms:** HTTP 500, `critical: true`, `alert: Provider payout completed but driver ledger was not fully debited`.

**Recovery (immediate):**

1. **Stop** all other payouts — set `ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED=false`
2. Record Stripe IDs from response/logs
3. Invoke `admin-sync-payout-ledger` with `payout_item_id`
4. Verify ledger debit + wallet recalc
5. If sync fails: manual ledger entry via approved finance RPC only — never ad-hoc SQL
6. Post-incident report; root-cause before re-enable

**This was the orphan path in Phase 3C (auto Connect payouts without ledger). Connect lockdown prevents new auto orphans; R4 prevents new admin orphans.**

### 7.6 R5 — Duplicate payout prevention

**Controls already in prod:**

| Control | Mechanism |
|---------|-----------|
| Idempotency | Stripe `idempotencyKey: payout_{payout_item_id}` |
| In-flight guard | `findInFlightPayoutItem` — 409 `PAYOUT_IN_FLIGHT` |
| Confirmation | `confirm_payout: true` required |
| Execution gate | Secret must be true |
| Connect manual | No automatic bank sweeps |
| Verification mode early exit | Before any DB/Stripe (3D.1) |

**If duplicate suspected:**

1. Compare Stripe metadata `payout_item_id`
2. Check ledger for duplicate `stripe_payout_id`
3. Do not retry — reconcile existing objects

### 7.7 R6 — Wrong amount / wrong driver

**Recovery:**

1. **Do not** attempt Stripe reversal without Ahmed + Stripe support guidance
2. Document operational loss (see MK0002 `po_1TjUCp` pattern — partial debit + `finance_reconciliation_notes`)
3. Ledger adjustment via approved dispute/adjustment workflow
4. Update ops log and reconciliation notes

### 7.8 Stripe timeout / unknown state

**Symptoms:** HTTP timeout, unknown whether transfer/payout created.

**Recovery:**

1. Set execution false immediately
2. Search Stripe by idempotency key `payout_{payout_item_id}`
3. If transfer exists: link to item, proceed to ledger sync — do not create second transfer
4. If nothing exists: safe to retry with same idempotency key
5. Document ambiguous state before retry

### 7.9 Emergency stop

```
1. ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED=false
2. Notify Ahmed + finance team
3. Run phase3d4-finance-closure-verification.ts
4. Run admin-connect-payout-status
5. No further payouts until incident review complete
```

---

## Appendix A — Current NO-GO summary

| Blocker | Until resolved |
|---------|----------------|
| Execution secret disabled | Super Admin enable per §6.4 |
| Ahmed approval missing | Written sign-off |
| MK0001 wallet −£2.78 | In-flight payout completes + wallet policy |
| MK0002 wallet −£23.00 + RECONCILIATION_MISMATCH | Finance remediation |
| Region Driver Available Now £0 | No eligible payout amount |
| In-flight `po_1TjdXr` | Monitor to `paid` |

---

## Appendix B — Implementation roadmap (post-plan)

| Phase | Deliverable | Type |
|-------|-------------|------|
| 3E.1 | Payout Operations dashboard (§5) | Code |
| 3E.2 | Scheduled audit cron + P0 alerts | Infra |
| 3E.3 | First live payout execution + report | Ops |
| 3E.4 | MK0002 reconciliation remediation | Finance |
| 3E.5 | Negative wallet policy formalized | Policy |

---

## Stop condition

This document is the **Phase 3E planning deliverable**. No code was changed. No Stripe updates, ledger writes, or deployments were performed.

**Next action:** Ahmed review of §6 First Live Payout Gate → resolve MK0001 in-flight payout → first eligible driver dry-run day-of → controlled enablement window.
