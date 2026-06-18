# Phase 3D.1 — Payout Safety Lockdown Report

**Date:** 2026-06-18  
**Priority:** P0  
**Project:** `thazislrdkjpvvghtvzo` (prod)  
**Region:** MK (`7f611e59-a9e5-42c2-b65a-61376910bb5d`)

---

## Executive summary

Phase 3D.1 deployed payout safety gates to production, cancelled orphan weekly settlement artifacts from the Phase 3D verification incident, and re-ran dry-run verification with **zero** new batches, items, ledger writes, or Stripe objects.

**Decision: NO-GO** for the first controlled live payout until Ahmed explicitly approves setting `ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED=true` and a staged execution test is completed.

---

## Incidents during this phase

### Incident A — Phase 3D (pre-3D.1)

| Field | Value |
|-------|-------|
| Driver | MK0001 (Ahmed) |
| Transfer | `tr_1TjdMjEeK1Cb9ZBxVHEeUaii` |
| Amount | £0.87 |
| Cause | Pre-gate `admin-driver-payout` v178 executed Stripe without `confirm_payout` / execution gate |

### Incident B — Phase 3D.1 initial verification (before gate fix propagated)

| Field | Value |
|-------|-------|
| Driver | MK0001 (Ahmed) |
| Transfer | `tr_1TjdXqEeK1Cb9ZBxVHEeUaii` |
| Payout | `po_1TjdXrEXTz9Ab5Ic7xa29zfU` |
| Batch | `90daa712-34cb-43a9-9e19-89885a6b3767` |
| Item | `8ab91a82-b271-42db-910b-7f8c2948603d` |
| Ledger | `d995699f-99be-48df-9a11-efcd8a9bfabe` (−278p) |
| Amount | £2.78 |
| Cause | First `phase3d1` script run hit stale `admin-driver-payout` edge before early-exit gate was live; `verification_mode` not honoured |

**Remediation applied:** Early `verification_mode` / `dry_run` exit moved to immediately after auth (before any payout path). Redeployed with `payout_safety_version: "3d.1"`. Re-verification **PASS** — no further Stripe activity.

**No Stripe reversals were executed** (per phase constraints).

---

## Objective 1 — Deploy 3C.3e payout functions

| Function | Status | Gate |
|----------|--------|------|
| `admin-driver-payout` | Deployed v181 (2026-06-18) | `ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED` + `verification_mode` / `dry_run` |
| `admin-weekly-monday-settlement` | Deployed v6 (2026-06-18) | Same |

**Secret set on prod:**

```
ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED=false
```

Mandatory before any batch creation, item creation, ledger debit, or Stripe transfer/payout in admin payout paths.

**Shared module:** `supabase/functions/_shared/payoutExecutionGate.ts`

---

## Objective 2 — Cancel orphan weekly artifacts

Migration: `20260719120000_phase_3d1_orphan_weekly_cancel.sql`

| Artifact | ID | Before | After |
|----------|-----|--------|-------|
| Batch | `8819ebee-cb96-406f-9f30-035baac119c5` | READY, 307p | `failed`, 0p, `ORPHAN_CANCELLED_3D1` |
| Item | `0c12e3dc-a8e9-4331-8080-2a5c713d4e9a` | pending, 307p | `FAILED_DUPLICATE`, 0p, `ORPHAN_CANCELLED_3D1` |

**Verified:**

- No ledger row linked to orphan item
- `stripe_transfer_id` / `stripe_payout_id` remain NULL
- Amounts zeroed — no future execution risk

---

## Objective 3 — Payout entrypoint audit

| Entrypoint | Stripe transfer/payout? | Execution gate | Verification mode |
|------------|----------------------|----------------|-------------------|
| `admin-driver-payout` | Yes | `ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED=true` required | `verification_mode` / `dry_run` → early exit |
| `admin-weekly-monday-settlement` | No (batch shell only) | Same for batch/item writes | Same |
| `admin-monday-payout-diagnostics` | No | N/A (read-only) | N/A |
| `admin-payout-batches` | No | N/A (read-only) | N/A |
| `admin-sync-payout-ledger` | Lists existing Stripe payouts; writes ledger debits for **already-paid** orphans | **Not gated** — operational backfill path; does not create new transfers | Should not be invoked during verification |
| `_shared/stripeSettlement.ts` | Trip capture settlement | Trip flow, not admin payout | N/A |
| `_shared/paymentProviders/stripeAdapter.ts` | `createTransfer` / `createPayout` via `admin-payment-providers` | **Not gated in 3D.1** — separate provider admin API; not used by payout UI today | Follow-up recommended |
| `drive-hub-buddy` `driver-early-cashout` | Yes | Out of admin-new deploy scope | Separate follow-up |

**Admin payout execution paths are gated.** Ledger-sync and trip-settlement paths are documented separately and were not modified in 3D.1.

---

## Objective 4 — Verification mode

Explicit guards via `verification_mode: true` or `dry_run: true`:

- Exit **before** payout batch creation
- Exit **before** payout item creation
- Exit **before** ledger debit
- Exit **before** Stripe API calls (balance retrieve skipped in verification mode for manual payout)

Response includes `payout_safety_version: "3d.1"` for deploy confirmation.

---

## Objective 5 — Dry-run verification (post-deploy)

Script: `scripts/phase3d1-payout-safety-verification.ts`  
Output: `docs/phase3d1-verification-output.json`

**Final run: PASS**

| Check | Result |
|-------|--------|
| `admin-weekly-monday-settlement` + `verification_mode` | 200, `batch_id: null`, `payout_safety_version: 3d.1` |
| `admin-driver-payout` + `verification_mode` | 200, simulated only, `payout_safety_version: 3d.1` |
| `admin-monday-payout-diagnostics` | 200 (read-only) |
| Δ payout_batches (5 min window) | 0 |
| Δ payout_items | 0 |
| Δ driver_wallet_ledger | 0 |
| Stripe objects created | 0 |

---

## Current MK driver wallet state (post-incidents)

| Driver | Wallet SSOT | Notes |
|--------|-------------|-------|
| MK0001 | £0.00 | After £0.87 + £2.78 unintended payouts |
| MK0002 | −£23.00 | Unchanged (Option 3 remediation) |

---

## GO / NO-GO decision

### NO-GO — first controlled live payout

**Reasons:**

1. `ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED` must remain `false` until Ahmed explicit approval.
2. Two unintended live transfers occurred during verification phases — operational discipline required before enabling execution.
3. MK0002 remains in negative wallet / reconciliation mismatch — not eligible for manual payout.
4. `admin-sync-payout-ledger` and `stripeAdapter` transfer paths are not yet behind the same execution gate (follow-up).
5. First live payout should be a **single-driver, Ahmed-approved, confirm_payout=true** test with execution flag enabled in a monitored window — not Monday batch.

**Conditions for future GO:**

- [ ] Ahmed written approval to set `ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED=true`
- [ ] Staged single MK0001 manual payout with `confirm_payout: true` (positive SSOT balance required)
- [ ] Post-execution ledger + Stripe reconciliation check
- [ ] Gate `admin-sync-payout-ledger` orphan discovery behind execution flag or admin-only schedule

---

## Artifacts

| File | Purpose |
|------|---------|
| `supabase/functions/_shared/payoutExecutionGate.ts` | Shared safety gate |
| `supabase/functions/_shared/payoutExecutionGate.test.ts` | Unit tests |
| `supabase/migrations/20260719120000_phase_3d1_orphan_weekly_cancel.sql` | Orphan cancel |
| `scripts/phase3d1-payout-safety-verification.ts` | Safe verification runner |
| `docs/phase3d1-verification-output.json` | Machine-readable PASS output |

---

## Stop condition

This phase ends at this report. **No Stripe transfers, payouts, or settlement batches were executed during the final verification pass.**
