# Slice 8 — Stripe runtime retirement

**Status:** Deployed & verified (2026-07-12).  
**Scope:** Labels, gates, dead Stripe branches. No historical column deletes. No payouts. No money rewrite.

## Contract

- Active finance has **no Stripe dependency**
- `STRIPE_RUNTIME_DISABLED` remains default-on
- Payout provider resolution prefers `driver_payout_gateway`; never returns `stripe`
- Monday settlement: Revolut/manual does not require Connect ID or Stripe execution flag
- UI: Connected Account → Payout Destination; no hard-coded `stripe` provider display
- Historical `stripe_*` columns remain as **LEGACY_STRIPE_EVIDENCE** only
- FR never constructs a live Stripe client

## Required values (unchanged)

Ahmed £10.01 · Bosteyo £4.08 · Fleet £14.09 · Captured £16.58

## Deploy

- admin-new: `admin-weekly-monday-settlement`, `admin-finance-reconciliation`, `admin-driver-wallet-ssot`
- onecab: `admin-payout-ledger`

## Acceptance

- No active Stripe API in FR / Monday / DWL Available path
- Revolut Monday gate does not require `stripe_account_id`
- Ahmed/Bosteyo money unchanged
- No live payouts during validation
