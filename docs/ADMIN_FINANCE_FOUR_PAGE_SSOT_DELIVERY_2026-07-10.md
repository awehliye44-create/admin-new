# P0 Admin Finance SSOT — Four Pages Delivery Report

**Date:** 2026-07-10  
**Status:** Gap-close pass complete for review — **NOT DEPLOYED**

## Gap-close summary (post-audit)

| Gap | Status |
|-----|--------|
| Wallet owned mark-paid / create-batch | **CLOSED** — moved to Payout Ledger; wallet payouts read-only |
| Payment Sessions filters UI | **CLOSED** — full filter bar wired to backend request |
| Sanitised provider inspect | **CLOSED** — `inspect_provider_order_id` on `admin-payment-sessions` |
| Refund action | **CLOSED** — `admin-recover-revolut-orphan` refund when `can_refund` |
| Client-side money sums (wallet batch totals) | **CLOSED** — per-item backend amounts only |
| Wallet tabs (7) | **CLOSED** — Overview, Drivers, Ledger, Debt, Adjustments, Payout Allocations, History |
| FR Mismatches / Resolved History | **CLOSED** |
| FR Provider Fee + Pending provider fee | **CLOSED** |
| Cross-page links | **CLOSED** — PS↔FR↔Wallet↔Payout matrix filled |
| Dead `PaymentHoldsAttentionPanel` | **REMOVED** |

### Soft remaining (acceptable for review)
- FR Trips “Authorised” column not on `TripFinancialAuditRow` payload
- Payout retry/cancel still badge-only (mark-paid is the live writer)
- Screenshots / responsive QA not captured
- Edges + RBAC not deployed (explicit gate)

## Routes
`/payment-sessions` · `/financial-reconciliation` · `/driver-wallet-ledger` · `/payout-ledger`

## Sidebar order
1. Payment Sessions (SSOT)  
2. Financial Reconciliation (SSOT)  
3. Driver Wallet Ledger (SSOT)  
4. Payout Ledger (SSOT)

## Permissions
`payment-sessions` · `financial-reconciliation` · `driver-wallet-ledger` · `payout-ledger`

## New thin backends
- `admin-payment-sessions` (list + sanitised inspect)
- `admin-payout-ledger` (list)

## Writers reused (no duplicates)
- `admin-hold-action`
- `admin-recover-revolut-orphan`
- `admin-weekly-monday-settlement`
- `admin-mark-manual-payout-paid`

## Confirmation
- No duplicate financial tables  
- No client-side fare/commission/driver_net formulas added  
- NULL amounts labelled  
- Hold release only on Payment Sessions  
- Payout create-batch / mark-paid only on Payout Ledger  
- **Do not deploy until reviewed**
