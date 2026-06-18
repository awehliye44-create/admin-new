# Phase 3D.3 — Connect Auto-Payout Lockdown Report

**Date:** 2026-06-18  
**Project:** `thazislrdkjpvvghtvzo` (prod)  
**Status:** **COMPLETE — lockdown applied and verified**

---

## Executive summary

Stripe Connect automatic bank sweeps on MK0001 and MK0002 have been disabled by setting payout schedule to **manual**. New driver onboarding defaults to manual. Admin visibility and audit endpoints are deployed. No payouts, transfers, or ledger debits were executed during this phase.

| Requirement | Result |
|-------------|--------|
| Set all Connect accounts to manual payouts | **Done** — MK0001 + MK0002 |
| Future onboarding accounts manual by default | **Done** — `stripe-onboard-driver` |
| Audit endpoint | **Done** — `admin-connect-payout-lockdown` + DB table |
| Admin visibility page | **Done** — `/connect-payout-lockdown` |
| No automatic driver-bank capability | **Verified** — `automatic_count: 0` |
| No payout execution / ledger writes / transfers | **Verified** — `ledger_delta: 0` |

---

## 1. Connect accounts — before / after

| Driver | Stripe account | Before | After | Applied at (UTC) |
|--------|----------------|--------|-------|------------------|
| **MK0001** Ahmed | `acct_1ThTrEEXTz9Ab5Ic` | daily, 7d delay, auto | **manual** | 2026-06-18 11:52:57 |
| **MK0002** Asiya | `acct_1ThUR8Izd0dzmC0Y` | daily, 7d delay, auto | **manual** | 2026-06-18 11:52:53 |

**Post-lockdown balances (unchanged by settings update):**

| Driver | Connect available | Connect pending | In-flight |
|--------|-------------------|-----------------|-----------|
| MK0001 | £0.87 | £9.54 | `po_1TjdXr…` £2.78 pending (manual, ledger-linked) |
| MK0002 | £0.00 | £0.00 | none |

Historical automatic payouts (`po_1TjTPX`, `po_1TjUCp`) remain in Stripe history as **paid** — they are not cancelled and do not block lockdown. No new automatic Connect→bank payouts can be created while schedule is manual.

---

## 2. Deployed artifacts

### Database

- Migration `20260720120000_phase_3d3_connect_payout_lockdown.sql`
- Table `stripe_connect_payout_schedule_audit` (RLS: service_role write, admin read)

### Edge functions

| Function | Purpose |
|----------|---------|
| `admin-connect-payout-status` | Read-only Connect schedule, balances, in-flight payouts |
| `admin-connect-payout-lockdown` | Dry-run / `confirm_lockdown` apply manual schedule |
| `stripe-onboard-driver` (updated) | Set manual on create; ensure manual on existing accounts |

### Admin UI

- Route: `/connect-payout-lockdown`
- Sidebar: Finance & Payouts → **Connect Payout Lockdown**
- Hook: `useConnectPayoutStatus`

### Scripts

- `scripts/phase3d3-connect-lockdown-verification.ts`
- Output: `docs/phase3d3-verification-output.json`

---

## 3. Verification results

### 3D.3 lockdown (2026-06-18)

```
Dry run:  2 accounts would change daily → manual
Apply:    LOCKDOWN_APPLIED on MK0001 + MK0002
After:    automatic_count: 0, manual_count: 2
Ledger:   0 new driver_wallet_ledger rows
Payout:   admin-driver-payout verification_mode — 3D.1 gate active, no Stripe calls
Verdict:  PASS
```

Re-run without apply:

```bash
npx tsx scripts/phase3d3-connect-lockdown-verification.ts
```

Apply (explicit opt-in only):

```bash
PHASE_3D3_APPLY_LOCKDOWN=true npx tsx scripts/phase3d3-connect-lockdown-verification.ts
```

### 3D.1 payout safety (re-run post-lockdown)

3D.1 dry-run suite **PASS** — orphan batch cancelled, verification gates active, no new batches/items/ledger rows.

---

## 4. Automatic payout path audit

| Path | Auto bank sweep? | Status |
|------|------------------|--------|
| Stripe Connect schedule (MK drivers) | Was yes | **Blocked** — manual |
| `stripe-onboard-driver` new accounts | Was default daily | **Manual enforced** |
| `admin-driver-payout` | Admin-only | **Gated** — `ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED=false` |
| Platform weekly bank sweep | Platform only | Unchanged (not driver Connect) |

No code paths remain that initiate **automatic** Connect→driver-bank sweeps. Admin-initiated payouts in `admin-driver-payout` remain behind 3D.1 execution lock.

---

## 5. GO / NO-GO

| Decision | Verdict |
|----------|---------|
| Connect auto-payout lockdown | **GO — complete** |
| First controlled live driver payout | **NO-GO** (unchanged) |

**Remaining blockers for first live payout:**

1. Negative wallets (MK0001 −£2.78, MK0002 −£23.00)
2. `ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED` still **false**
3. Ahmed explicit approval for execution flag + staged single-driver test
4. Monitor in-flight `po_1TjdXr` (£2.78) to completion

---

## 6. Operator notes

- **Dry run** from admin UI or API before any future region expansion.
- **Apply lockdown** requires `confirm_lockdown: true` — settings change only, not a transfer.
- In-flight pending payouts complete normally; manual schedule does not cancel them.
- Connect pending balance (£9.54 MK0001) stays on Connect until admin payout engine runs (when enabled).

---

## Stop condition

Phase 3D.3 implementation complete. No further Stripe schedule changes required for current MK Connect inventory.
