# Phase 3C.3e — Admin Payout Implementation Report

**Date:** 2026-06-17  
**Status:** Implementation complete — **production Stripe payout execution remains NO-GO** until Ahmed explicit approval after dry-run verification.

## Summary

Aligned `admin-new` finance SSOT with Phase 3C hard/soft payout gate, implemented manual payout confirmation UI, weekly Monday settlement dry-run + batch creation, failed payout retry with duplicate guard, and ONECAB commission visibility (no sweep).

## Files changed

### Shared SSOT (`admin-new/supabase/functions/_shared/`)

| File | Change |
|------|--------|
| `financialReconciliationSSOT.ts` | Ported v3 digital reconciliation + MK soft classification |
| `perDriverFinancialReconciliation.ts` | Ported `buildPayoutGateReasons`, `payout_warning_reasons`, ledger liability |
| `onecabFinanceLedger.ts` | Added `computeLedgerWalletBalancePence` |
| `payoutInflightGuard.ts` | **New** — in-flight payout duplicate guard |

### Edge functions

| Function | Change |
|----------|--------|
| `admin-driver-payout` | Hard-only gate; `confirm_payout` required; `ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED` Stripe gate; `retry_payout_item_id` reuse; warning/blocked reasons in response |
| `admin-weekly-monday-settlement` | `dry_run` mode; soft-warning drivers included; warning reasons per result |
| `admin-finance-reconciliation` | Uses ported SSOT (via shared imports) |
| `admin-payout-batches` | Unchanged API — consumes aligned SSOT via shared |
| `admin-monday-payout-diagnostics` | Unchanged — UI shows failure_code |
| `admin-sync-payout-ledger` | Uses `MANUAL_PAYOUT` / `WEEKLY_PAYOUT` via `payoutLedgerSync` |
| `admin-stripe-payout-peek` | Unchanged — read-only |

### Admin UI

| File | Change |
|------|--------|
| `src/lib/manualPayoutGate.ts` | Hard-only `canManualPayout`; soft warning helpers |
| `src/hooks/usePerDriverFinancialReconciliation.ts` | `payout_warning_reasons` type |
| `src/components/finance/ManualPayoutConfirmDialog.tsx` | **New** confirmation modal |
| `src/components/finance/DriverSSOTPayoutPanel.tsx` | Amber soft warning; in-flight guard |
| `src/components/finance/WeeklyMondaySettlementPanel.tsx` | **New** dry-run + create batch |
| `src/components/finance/OnecabCommissionVisibility.tsx` | **New** commission visibility |
| `src/components/finance/MondayPayoutDiagnosticsTable.tsx` | `failure_code`; safe retry only |
| `src/pages/AdminDriverSettlements.tsx` | Pay Driver Now + modal; commission panel |
| `src/pages/AdminPayoutBatches.tsx` | Weekly settlement panel; commission panel |
| `src/hooks/useMondayPayoutDiagnostics.ts` | Retry via `retry_payout_item_id`; duplicate guard |

### Tests & scripts

| File | Purpose |
|------|---------|
| `src/lib/__tests__/manualPayoutGate.phase3c3e.test.ts` | UI gate tests |
| `src/lib/__tests__/phase3c3ePayoutGate.test.ts` | SSOT + ledger type tests |
| `scripts/phase3c3e-mk-dry-run-verification.ts` | MK0001/MK0002 dry-run |

### Docs

| File | Purpose |
|------|---------|
| `docs/PHASE_3C04_ONECAB_COMMISSION_SWEEP_PLAN.md` | Commission sweep design (not implemented) |

## Functions to deploy (when approved)

```
admin-driver-payout
admin-weekly-monday-settlement
admin-finance-reconciliation
admin-payout-batches
admin-monday-payout-diagnostics
admin-sync-payout-ledger
admin-stripe-payout-peek
```

**Env for safe deploy:**

- `ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED` — leave **unset/false** until real payout approval

## Admin screens updated

- **Driver Settlements** — Pay Driver Now with confirmation modal; soft warning banner; commission visibility
- **Payout Batches & Audit** — Weekly Monday dry-run / create batch; failed payout retry; commission visibility
- **Driver detail dialog** — SSOT payout panel with hard/soft split

## Tests passed

```
vitest: 16/16 (manualPayoutGate + phase3c3ePayoutGate)
tsx scripts/phase3c3e-mk-dry-run-verification.ts: PASSED
```

## MK dry-run results (local SSOT)

### MK0001 (`5ed232c3-8bb5-4085-95d6-73e48e6c5e28`)

| Check | Result |
|-------|--------|
| Ready for payout | ~£3.05 (305p) |
| Hard blocked | false |
| Soft warning | true |
| Manual payout UI | enabled with amber warning |
| Weekly batch | included |

### MK0002 (`cd8bae4c-3827-4b90-98c6-10be70eb0e52`)

| Check | Result |
|-------|--------|
| Ready for payout | ~£2.59 (259p) |
| Hard blocked | false |
| Soft warning | true |
| Manual payout UI | enabled with amber warning |
| Weekly batch | included |

## Screenshots

Not captured in this implementation session (UI deploy required for visual verification).

## Remaining NO-GO items

1. **Real Stripe driver payouts** — gated by `ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED=true`
2. **Weekly batch Stripe execution** — batch creates items only; transfers via `admin-driver-payout` per item
3. **ONECAB commission sweep** — visibility only; see `PHASE_3C04_ONECAB_COMMISSION_SWEEP_PLAN.md`
4. **Automatic cron Monday settlement** — not implemented
5. **Live prod verification** — requires deploy + MK region SSOT fetch against production data

## Request for real payout approval

Ahmed — after reviewing this report and running **Weekly Monday Dry Run** + **Manual Payout confirmation modal** against MK region in staging/prod UI:

1. Confirm MK0001/MK0002 dry-run matches live SSOT amounts
2. Explicitly approve enabling `ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED=true`
3. Approve first manual payout and/or weekly batch Stripe execution

**Until that approval, production payout execution remains blocked by design.**
