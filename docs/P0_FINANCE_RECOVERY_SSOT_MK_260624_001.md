# P0 Finance Recovery SSOT — MK-260624-001 Audit

**Trip:** `MK-260624-001` (`fe78eb78-651f-499b-b20b-ff015d52414c`)  
**Issue:** £4.49 outstanding recovered from Trip History only — violates Financial Reconciliation SSOT ownership.

## MK-260624-001 financial facts

| Field | Value |
|-------|-------|
| Settlement total | £8.49 (849p) |
| Primary PI captured | £4.00 (400p) |
| Outstanding (trip SSOT) | £4.49 (449p) |
| Root cause | Cash→card switch authorised 400p; finalize capped capture at auth |

## Pre-fix audit (violation)

| Question | Finding |
|----------|---------|
| Which page triggered £4.49 recovery? | **Trip History** trip detail dialog (`PaymentControlsCard`) |
| Which edge function? | **`admin-request-extra-payment`** (shared — not Trip History–specific) |
| Shared SSOT backend? | **Yes** — same function as Payments & Transactions |
| Financial Reconciliation had recapture UI? | **No** — read-only audit table only |
| `outstanding_balance_pence` after success? | Expected → **0** when £4.49 PI succeeds |
| Reconciliation mismatch clears? | When `captured_total >= settlement` and outstanding = 0 |
| Stripe total £8.49? | Primary £4.00 + extra PI £4.49 = **£8.49** |

**Violation:** Recovery **UI ownership** lived on Trip History / Payments detail, not on Financial Reconciliation SSOT page.

## Fix (this change)

### Backend — `admin-request-extra-payment`

- Server computes settlement (`final_fare + tip + extras`) and sum of `payments.captured_amount_pence`.
- Charge amount = `outstanding_balance_pence` when aligned with settlement − captured (±1p).
- **Rejects** client `amount_pence` when it disagrees with server delta.
- Audit metadata includes `settlement_total_pence`, `captured_total_pence`, `recovery_source`, `admin_user_id`.

### Backend — `admin-edit-trip-fare` (gap closure)

- **Blocks** fare increases that would charge outstanding delta — directs to `admin-request-extra-payment`.
- **Updates** `outstanding_balance_pence` and `payment_coverage_status` on waive / internal adjustment.

### Admin UI

| Page | Behaviour |
|------|-----------|
| **Financial Reconciliation** | Capture mismatch badge + **Outstanding** column + **Recapture** → finance recovery dialog (SSOT owner) |
| **Payments & Transactions** | `FinanceRecoveryPanel` (full recovery actions) + per-PI payment rows |
| **Trip History** | Read-only mismatch + **Open Financial Reconciliation** link (no standalone recovery workflow) |

- Edit Fare hidden when outstanding balance exists (forces SSOT extra payment).
- Deep link `?trip=…&recover=1` opens recovery even when trip is outside audit date filter.
- CI guard: `scripts/check-finance-recovery-ssot.sh`

All recovery actions still call the same `admin-request-extra-payment` / `admin-edit-trip-fare` via `PaymentControlsCard`.

## Acceptance tests

1. Partial capture 849p settlement / 400p captured → Financial Reconciliation shows **Recapture**.
2. Admin recapture → backend creates PI for **449p only** (server-side).
3. Success → `outstanding_balance_pence = 0`, mismatch cleared.
4. Trip History → link to Financial Reconciliation; no isolated finance workflow.
5. Payments list → shows primary + extra payment rows.
6. Second recapture when outstanding = 0 → **blocked** by backend.

## Deploy

```bash
supabase functions deploy admin-request-extra-payment --project-ref thazislrdkjpvvghtvzo
```

Admin panel: push `admin-new` main (GitHub Actions CDN).
