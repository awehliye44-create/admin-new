# Phase 3C.04 — ONECAB Commission Sweep Plan

**Status:** Design only — not implemented in Phase 3C.3e  
**Author:** Engineering (admin-new / finance SSOT)  
**Date:** 2026-06-17

## Goal

Transfer ONECAB net card commission from the Stripe platform balance to the ONECAB corporate bank account on a controlled schedule, with full audit trail and reconciliation against `finance_reconciliation_summary` SSOT.

## Current state (Phase 3C.3e)

- Card trip `application_fee_amount` accumulates in Stripe platform balance.
- Admin **Commission Visibility** panel shows gross/net commission, Stripe fees, cash commission due/recovered, and swept/pending amounts (read-only).
- **No** automated sweep, cron, or admin “Sweep Now” transfer exists.
- Driver payouts (`MANUAL_PAYOUT` / `WEEKLY_PAYOUT`) are separate from platform commission extraction.

## Proposed sweep architecture

### 1. SSOT inputs

| Field | Source |
|-------|--------|
| `onecab_gross_commission_pence` | `finance_reconciliation_summary` |
| `provider_processing_fee_pence` | Stripe fee SSOT |
| `onecab_net_commission_pence` | gross − fees (digital scope) |
| `onecab_bank_payout_pence` | Sum of completed commission sweep batches |
| Pending unswept | `onecab_net_commission_pence − onecab_bank_payout_pence` |

### 2. New tables (draft)

- `commission_sweep_batches` — run_date, status, total_pence, stripe_payout_id, created_by
- `commission_sweep_items` — batch_id, region_id, amount_pence, status, failure_code, provider_response

### 3. Edge function: `admin-onecab-commission-sweep`

**Modes:**

- `dry_run: true` — compute sweepable amount, no Stripe
- `confirm_sweep: true` — required for execution
- Env gate: `ADMIN_COMMISSION_SWEEP_ENABLED=true` (default false)

**Rules:**

- Never sweep more than SSOT `onecab_net_commission_pence − already_swept`
- Never sweep if digital reconciliation has **hard** mismatch
- Soft MK variance → warning only (mirror driver payout 3C.3 gate)
- Idempotency key per batch row

### 4. Stripe operation

- `stripe.payouts.create` on **platform account** (not Connect transfer)
- Destination: ONECAB verified bank account on platform
- Ledger entry type: `PLATFORM_COMMISSION_SWEEP` (reporting + balance adjustment — TBD with ledger SSOT)

### 5. Admin UI

- Section under Financial Reconciliation / Platform Finance
- Show pending unswept, last sweep batch, failures
- Actions: Dry Run Sweep, Create Sweep Batch (no auto-cron until approved)

### 6. Safety gates (NO-GO until Ahmed approval)

1. `ADMIN_COMMISSION_SWEEP_ENABLED` env
2. `confirm_sweep` checkbox in UI
3. Hard reconciliation block
4. Max sweep cap = SSOT pending
5. Separate from driver payout execution flag

## Sequencing

1. Phase 3C.3e — driver payout UI + batch creation (Stripe gated) ✅
2. Phase 3C.04 — implement sweep tables + dry-run edge + visibility wiring
3. Production approval — enable `ADMIN_COMMISSION_SWEEP_ENABLED` after MK region dry-run

## Open questions

- Per-region vs global sweep batches?
- Cash commission recovery timing vs card commission sweep (keep separate ledgers)
- Tax / invoice linkage for swept commission

## Explicit non-goals (this doc)

- Automatic daily cron sweep
- Mixing driver Connect transfers with platform commission payout
- Retroactive sweep without reconciliation SSOT alignment
