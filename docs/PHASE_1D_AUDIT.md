# Phase 1D — Legacy Finance Screen Alignment (Audit Report)

**Date:** 2026-06-16  
**Status:** AUDIT ONLY — no implementation in this document  
**Authority:** Financial Reconciliation SSOT (`admin-finance-reconciliation`)  
**Phase 1C:** SIGNED OFF (UI spot-check PASS)

---

## Objective

Align remaining admin screens, exports, and invoice surfaces to settlement SSOT definitions:

| Term | SSOT rule |
|------|-----------|
| **Customer Paid** | Card → `payments.captured_amount_pence`; cash → `final_fare_pence` / collected |
| **Driver Net** | `driver_wallet_ledger.TRIP_EARNING_NET` → `trips.driver_net_pence`; never `fare − commission` |
| **Missing net** | `null` / **Unknown** — never invented |

---

## Hard constraints (do not violate)

- No payout engine changes
- No ledger writes / ledger schema changes
- No Stripe webhook changes
- No Monday settlement changes
- No `supabase db push`
- Smallest safe diffs; test before deploy

---

## Phase 1C — Completed (reference)

| Screen | Status |
|--------|--------|
| Financial Reconciliation | PASS |
| Admin Payments (list + detail) | PASS |
| Trip History | PASS |
| Cash / card / recovery verification | PASS |

Shared helpers in use: `src/lib/tripCaptureStatus.ts`, `supabase/functions/_shared/tripSettlementFinanceSSOT.ts`.

---

## Findings summary

| ID | Area | Risk | Effort | Action |
|----|------|------|--------|--------|
| **1D-01** | `ServiceAreaTripsTab.tsx` | **High** — wrong fare on card trips with waiting/capture delta | S | Align Fare column to settlement SSOT |
| **1D-02** | `CorporateReports.tsx` | **High** — revenue KPIs/charts use `gross_fare_pence` | M | Settlement fare + payments join |
| **1D-03** | `CorporateBilling.tsx` | **High** — trip revenue stat + row fare use `gross_fare_pence` | M | Same as 1D-02 |
| **1D-04** | Export stubs (4 screens) | **Medium** — fake or no-op exports mislead ops | M | Wire SSOT CSV or disable with label |
| **1D-05** | `TripInvoiceCard` / trip invoice writer | **Medium** — snapshot field may pre-date SSOT | M | Audit `trip-invoice-process` (external); writer fix |
| **1D-06** | `FinanceSettlementOverview.tsx` | **Low** — dead component (not routed) | S | Delete or document; already SSOT-backed |
| **1D-07** | `FinanceTotalsCards.tsx` + `useAdminFinanceSummary` | **Low** — deprecated, unused in routes | S | Remove imports or add `@deprecated` banner |
| **1D-08** | `MarketplaceSettlements.tsx` CSV | **Low** — exports `gross_sales_pence` (currently 0) | S | Label columns; SSOT when orders exist |
| **1D-09** | `admin-payments-summary` edge fn | **Low** — pending amount uses `gross_fare_pence` | S | Fix only if UI re-enabled |
| **1D-10** | `admin-payment-detail` confirm path | **N/A Phase 1D** | — | Ledger **write** on confirm — out of scope |

---

## Detailed findings

### 1D-01 — Service Area Trips tab (P1)

**File:** `src/components/payment/ServiceAreaTripsTab.tsx`  
**Route:** Service Area Pricing → Recent trips tab  
**Issue:** Fare column uses `final_fare_pence ?? gross_fare_pence` (line 101).  
**Impact:** Card trips where captured amount ≠ legacy fare (e.g. MK-260615-006: captured 512p vs gross 480p) show wrong fare in list before opening `PaymentControlsCard`.  
**Fix:** Fetch `payments.captured_amount_pence` (or invoke shared helper client-side with trip + payment row). Rename column **Customer Paid** / **Settlement**.  
**Tests:** Reuse `tripCaptureStatus` prod snapshots.

---

### 1D-02 — Corporate Reports (P1)

**File:** `src/pages/CorporateReports.tsx`  
**Issues:**
- `totalRevenuePence` sums `gross_fare_pence` (line 209)
- `calculateMonthlyTrends` uses `gross_fare_pence` (line 158)
- Account breakdown revenue uses `gross_fare_pence` (line 565 area)

**Impact:** Corporate revenue charts and KPIs diverge from Financial Reconciliation for card trips with capture/waiting deltas.  
**Fix:** Join `payments` for trip IDs in query (or batch fetch). Use `getTripSettlementFarePence()` per trip. Label UI **Customer Paid (settlement)**.  
**Export:** `handleExportReport` is a toast stub (line 221) — must export SSOT columns or stay disabled.

---

### 1D-03 — Corporate Billing (P1)

**File:** `src/pages/CorporateBilling.tsx`  
**Issues:**
- `totalCorpRevenue` prefers `gross_fare_pence` (lines 266–271)
- Trip table fare column uses `gross_fare_pence` (lines 601–602)
- **Export** button has no handler (line 468)

**Impact:** Corporate ops sees legacy gross, not customer-paid settlement.  
**Fix:** Same pattern as 1D-02. Corporate account method trips still use settlement fare rules from `tripCaptureStatus`.

---

### 1D-04 — Export stubs (P1)

| Location | File | Current behavior |
|----------|------|------------------|
| Admin Payments | `AdminPayments.tsx:471` | Button, no `onClick` |
| Driver Settlements | `AdminDriverSettlements.tsx:309` | Button, no `onClick` |
| Corporate Billing | `CorporateBilling.tsx:468` | Button, no `onClick` |
| Corporate Reports | `CorporateReports.tsx:221` | `toast.success` only |

**Recommendation:** Implement CSV from existing loaded SSOT data (Payments list API, reconciliation audit rows) **or** disable buttons with tooltip *"Export — Phase 1D"*. Do not export `gross_fare_pence`.

**Proposed export columns (trips):** trip_code, completed_at, payment_method, customer_paid_pence, driver_net_pence, commission_pence, onecab_net_pence, payment_status.

---

### 1D-05 — Trip invoice writer (P1)

**Files:**
- `src/components/trips/TripInvoiceCard.tsx` — displays `invoice_total_paid_pence` snapshot (correct for historical PDFs)
- TODO at line 3: writer must persist `getTripSettlementFarePence` at generation time

**Gap:** `trip-invoice-process` edge function **not present in this repo** (invoked from TripInvoiceCard). Cannot audit writer logic locally.  
**Action:**  
1. Locate deployed `trip-invoice-process` source (Supabase dashboard / separate repo).  
2. Verify `invoice_total_paid_pence` written from settlement fare, not `gross_fare_pence` / `final_customer_fare_pence`.  
3. Do **not** auto-regenerate historical invoices.

---

### 1D-06 — FinanceSettlementOverview (P2)

**File:** `src/components/finance/FinanceSettlementOverview.tsx`  
**Status:** Not imported in `App.tsx` routes — **dead UI**.  
**Note:** Component already reads `useFinancialReconciliationSSOT`. Safe to delete in cleanup PR or keep for embedded use later.

---

### 1D-07 — Deprecated finance summary hook (P2)

**Files:** `src/hooks/useAdminFinanceSummary.ts`, `src/components/finance/FinanceTotalsCards.tsx`  
**Status:** Hook marked `@deprecated`; **no page imports** found.  
**Action:** No user-facing fix required; optional removal to prevent future misuse.

---

### 1D-08 — Marketplace Settlements (P2)

**File:** `src/pages/MarketplaceSettlements.tsx`  
**Status:** Data from `merchants` table; financial columns default to **0** until marketplace orders emit settlements (documented in code).  
**CSV export:** Exports `gross_sales_pence` etc. — correct schema, zero data today.  
**Action:** Add CSV header note *"Marketplace settlement SSOT — zeros until order flow live"*. No trip SSOT overlap.

---

### 1D-09 — admin-payments-summary (P2)

**File:** `supabase/functions/admin-payments-summary/index.ts`  
**Issue:** `pendingAmount` sums `trips.gross_fare_pence` (line 77).  
**Usage:** Only `queryClient.invalidateQueries` from `PaymentControlsCard` — **no active UI consumer** found.  
**Action:** Fix if re-wired to UI; otherwise defer.

---

### 1D-10 — Out of scope (ledger write)

**File:** `supabase/functions/admin-payment-detail/index.ts` (confirm_payment POST)  
**Issue:** `netPence = trip.driver_net_pence || (gross_fare_pence - commission_pence)` before ledger insert (line 136).  
**Reason excluded:** Modifying this path is a **ledger write** change — violates Phase 1D constraints.  
**Track separately** if admin confirm-payment is still used in prod.

---

## Explicitly out of Phase 1D

| Item | Track as |
|------|----------|
| Ahmed Osman wallet cache drift −436p | **Phase 1E** |
| Payout engine / Monday settlement | Future phase |
| Driver app / wallet redesign | Phase 2–3 (blocked) |
| `repair-commissions`, `handle-cash-trip-commission` | Backend ops — not admin display |

---

## Recommended implementation order

1. **1D-01** ServiceAreaTripsTab (smallest, high visibility in pricing ops)  
2. **1D-02 + 1D-03** Corporate Reports + Billing (shared helper extraction)  
3. **1D-04** Export stubs (disable or SSOT CSV)  
4. **1D-05** Trip invoice writer (requires locating external function)  
5. **1D-06 / 1D-07 / 1D-08 / 1D-09** Cleanup / documentation  

---

## Test plan (before each deploy)

| Check | Reference trips |
|-------|----------------|
| Card captured | MK-260615-006 — Customer Paid £5.12, Driver Net £4.35 |
| Card + waiting | MK-260615-017 — captured 523p |
| Cash | MK-260615-004 — final_fare 793p |
| Recovery | MK-260615-019 — captured 480p |
| Corporate account | MK-260616-016 — corporate method, settlement fare |

**Automated:** `vitest` `tripCaptureStatus.test.ts`; Deno `financeSettlementSummary.test.ts`, `tripSettlementFinanceSSOT.test.ts`.  
**Manual:** Hard refresh admin; compare row to Financial Reconciliation audit for same trip.

---

## Rollback

- Frontend: revert commit + Lovable sync  
- Edge functions: redeploy previous version from git  
- No DB migration required for Phase 1D display fixes

---

## Sign-off gate

Phase 1D complete when:

- [ ] 1D-01 through 1D-04 implemented or explicitly deferred with UI disabled  
- [ ] 1D-05 writer audited (or documented blocked pending function source)  
- [ ] No new screens use `gross_fare_pence` for **Customer Paid** display  
- [ ] Human spot-check on 4 reference trips per changed screen
