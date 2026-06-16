# Phase 1D-04 — Finance Export / CSV Audit

**Date:** 2026-06-16  
**Status:** COMPLETE — audit + preparatory SSOT helper; stub buttons unchanged  
**Authority:** Financial Reconciliation SSOT

---

## 1. Export paths audited

| Area | File | Button / path | Type | Finance risk |
|------|------|---------------|------|--------------|
| Admin Payments | `AdminPayments.tsx:471` | Export | **STUB** — no `onClick` | None |
| Driver Settlements | `AdminDriverSettlements.tsx:309` | Export | **STUB** — no `onClick` | None |
| Financial Reconciliation | `FinancialReconciliation.tsx` | — | **No export** | None |
| Corporate Reports | `CorporateReports.tsx:252` | Export | **STUB** — `toast.success` only | None |
| Corporate Billing | `CorporateBilling.tsx:518` | Export | **STUB** — no `onClick` | None |
| Marketplace Settlements | `MarketplaceSettlements.tsx:127` | Export CSV | **LIVE** — merchant CSV | Low (zeros; not trip SSOT) |
| Trip invoice | `TripInvoiceCard.tsx:93` | Download PDF | **LIVE** — snapshot | Snapshot only |
| Driver statements | `Invoices.tsx:470` | Download PDF | **LIVE** — snapshot | Snapshot only |
| Driver invoice preview | `InvoiceTemplates.tsx:163` | Preview | **LIVE** — sample HTML | Sample only |
| Corporate Accounts | `CorporateAccounts.tsx:318` | Export | **STUB** — no `onClick` | None |
| Staff (out of scope) | `RolesPermissions.tsx:533` | Export | LIVE — staff CSV | Not trip finance |

---

## 2. Stub exports (no live finance export risk)

Left **unchanged** per Phase 1D-04 rules:

- Admin Payments Export
- Admin Driver Settlements Export
- Corporate Reports Export (`handleExportReport` fake toast)
- Corporate Billing Export
- Corporate Accounts Export

When wired in a future phase, use `src/lib/financeTripExportCsv.ts` (SSOT columns + tests).

---

## 3. Live exports

### Marketplace Settlements CSV

- **Source:** `merchants` table; `gross_sales_pence` hardcoded **0** until marketplace order flow exists.
- **Not** `trips.gross_fare_pence` — separate merchant settlement model.
- **Risk label:** `PHASE_1D_FOLLOWUP` — when marketplace orders go live, confirm `gross_sales_pence` is order settlement snapshot, not legacy trip gross.
- **Change in 1D-04:** CSV disclaimer comment row added (documentation only).

### Trip invoice (`trip-invoice-process`)

- Downloads **existing** `invoice_pdf_url` / generated snapshot.
- Display uses `invoice_total_paid_pence` on trip row.
- **Do not regenerate** historical invoices.
- **TODO(Phase 1D-05):** Writer must persist `getTripSettlementFarePence()` at generation time.

### Driver monthly statements (`admin-driver-invoice`)

- PDF from `driver_invoices` snapshot (`gross_earnings_pence`, `net_earnings_pence`, etc.).
- Period statement — not per-trip live SSOT export.
- **Do not regenerate** without explicit approval.

---

## 4. Legacy fields — not in live trip exports

No live admin export currently emits:

- `gross_fare_pence` as completed trip revenue
- `estimated_fare` / `final_customer_fare_pence` as captured revenue
- `fare − commission` as driver net

**Driver Settlements table** still shows “Gross Fares” column on screen (display only, not export) — out of 1D-04 export scope.

---

## 5. Changes made (1D-04)

| Item | Change |
|------|--------|
| `docs/PHASE_1D_EXPORT_AUDIT.md` | This audit |
| `src/lib/financeTripExportCsv.ts` | SSOT trip CSV row builder (for future stub wiring) |
| `src/lib/__tests__/financeTripExportCsv.test.ts` | Reference trip tests |
| `MarketplaceSettlements.tsx` | CSV disclaimer comment row |

Stub export buttons **not** enabled (rule 1).

---

## 6. SSOT CSV columns (when trip exports are wired)

| Column | Source |
|--------|--------|
| Customer Paid | `getTripSettlementFarePence()` |
| Driver Net | `getTripDriverNetPence()` — Unknown if null |
| Commission | `trips.commission_pence` (display only) |

Never: Gross Fare, Gross Revenue for completed trip money.

---

## 7. Remaining export risks

| ID | Risk | Phase |
|----|------|-------|
| EXP-01 | Admin Payments Export stub — wire with `financeTripExportCsv` | Post–1D-04 |
| EXP-02 | Corporate Reports/Billing export stubs | Post–1D-04 |
| EXP-03 | Marketplace `gross_sales_pence` semantics when orders live | 1D follow-up |
| EXP-04 | Trip invoice writer SSOT at generation | **1D-05** |
| EXP-05 | Driver Settlements on-screen “Gross Fares” column | Display phase (not export) |

---

## Reference trips (CSV helper tests)

| Trip | Customer Paid | Driver Net |
|------|---------------|------------|
| MK-260615-006 | £5.12 | £4.35 |
| MK-260615-017 | £5.23 | £4.45 |
| MK-260615-004 | £7.93 | £6.87 |
| MK-260615-019 | £4.80 | £4.08 |
