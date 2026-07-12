# Slice 7 — Payout Ledger handoff + zero-batch

**Status:** Deployed & verified (2026-07-12).  
**Scope:** PL consumes DWL available + eligible ledger IDs only. Zero-batch hard rule. No live transfers.

## Contract

- PL never recalculates availability — consumes `fetchDriverPayoutEligibility` / DWL `available_balance_pence`
- Allocations FIFO across **eligible_entries only** (not all `TRIP_EARNING_NET`)
- Zero-batch: `eligible_driver_count = 0` OR `total_available_pence = 0` → `NO_ELIGIBLE_PAYOUTS`
  - Do **not** create batch, item, allocation, wallet debit, or provider transfer
- Manual + scheduled Monday settlement share the same eligibility gate
- Payout destination gate is provider-neutral (Revolut/manual bank OK without Stripe Connect)
- No Stripe reintroduction; no provider call during validation

## Required values (unchanged)

Ahmed £10.01 · Bosteyo £4.08 · Fleet £14.09

## Exact files

| File | Role |
|---|---|
| `shared/payoutLedgerHandoffSSOT.ts` | `planEligibleLedgerAllocations` + destination label |
| `shared/payoutAllocationEligibilitySSOT.ts` | `PAYOUT_DESTINATION_REQUIRED` (not Connect-only) |
| `adminPayoutLedgerAccountsOverviewSSOT.ts` (onecab) | Widgets + list fields from eligibility |
| `admin-weekly-monday-settlement` | Lazy batch create; eligible-entry allocation |
| `PayoutLedger.tsx` | Widgets, zero-batch banner, destination labels |

## Deploy

- onecab: `admin-payout-ledger`
- admin-new: `admin-weekly-monday-settlement`

## Acceptance

- Ahmed/Bosteyo Available match DWL
- Zero eligible → API returns `NO_ELIGIBLE_PAYOUTS`, no new £0 batch
- Historical £0 audit batches retained
- No real payouts during validation
