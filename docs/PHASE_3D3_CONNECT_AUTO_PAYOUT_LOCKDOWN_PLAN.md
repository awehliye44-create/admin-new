# Phase 3D.3 — Connect Auto-Payout Lockdown Plan

**Date:** 2026-06-18  
**Priority:** P0 (prerequisite for first controlled payout)  
**Project:** `thazislrdkjpvvghtvzo` (prod)  
**Status:** **PLAN ONLY** — no Stripe mutations, no payouts, no ledger writes in this phase

---

## Executive summary

Stripe Connect **automatic payouts** on MK0001 and MK0002 can sweep Connect balances to driver bank accounts **without** ONECAB `payout_batches`, `payout_items`, admin approval, or guaranteed `driver_wallet_ledger` debits. This is the root orphan-payout path identified in Phase 3D.2.

**Recommended policy:** Set **manual payout schedule** on every ONECAB driver Connect account. The **only** driver bank payout path becomes `admin-driver-payout` (gated by 3D.1 execution lock + Ahmed approval).

**GO/NO-GO (this plan):**

| Decision | Recommendation |
|----------|----------------|
| Disable Connect auto-payouts | **GO** — required before first controlled payout |
| Deploy manual-only policy | **GO** — after in-flight payout handling (§5) |
| First controlled payout readiness | **NO-GO until 3D.3 executed + verified** |

---

## 1. Active Connect accounts (prod inventory)

**Source:** DB `drivers.stripe_account_id` + Stripe `accounts.retrieve` + `balance.retrieve`  
**Audit snapshot:** 2026-06-18 (via `phase-3d2-stripe-balance-audit`)

| Driver code | Driver ID | Stripe Connect ID | Schedule | Auto? | Available | Pending | Next scheduled payout |
|-------------|-----------|-------------------|----------|-------|-----------|---------|------------------------|
| **MK0001** | `5ed232c3-8bb5-4085-95d6-73e48e6c5e28` | `acct_1ThTrEEXTz9Ab5Ic` | **daily**, delay **7d** | **Yes** | **£0.87** (87p) | **£9.54** (954p) | **Implicit:** next daily auto-sweep after 7-day rolling window on pending earnings (~£9.54+ at risk). **Explicit API pending:** `po_1TjdXr` **£2.78** (`pending`, manual, arrival scheduled) |
| **MK0002** | `cd8bae4c-3827-4b90-98c6-10be70eb0e52` | `acct_1ThUR8Izd0dzmC0Y` | **daily**, delay **7d** | **Yes** | **£0.00** | **£0.00** | None imminent (zero balance). Auto-sweep **enabled** — any future Connect credit would auto-pay |

**Platform account:** Not a Connect account — **out of scope** for driver lockdown (ONECAB commission bank sweeps remain separate).

**Total active Connect accounts in prod:** **2** (MK region only).

**DB flags (both drivers):**

- `drivers.payouts_enabled = true`
- `drivers.stripe_account_id` set
- `charges_enabled = true`, `details_submitted = true`

---

## 2. Target payout schedule (policy)

### Recommended end state

| Setting | Value | Rationale |
|---------|-------|-----------|
| `settings.payouts.schedule.interval` | **`manual`** | Stripe will not auto-create Connect→bank payouts |
| Automatic payouts | **Disabled** | `interval !== "manual"` is the 3D.2 audit definition |
| Driver bank payouts | **Admin engine only** | `admin-driver-payout` → transfer + optional payout, ledger sync |
| New driver onboarding | **Default manual** | Onboard hook sets manual at account creation / first connect |

### What manual does **not** block

- Platform → Connect **transfers** (trip settlement) — unchanged  
- Admin-initiated payout when execution enabled — unchanged  
- **In-flight** payouts already created (`pending` / `in_transit`) — complete normally  

### What manual **does** block

- Stripe-initiated automatic Connect→bank sweeps (`automatic: true` payouts like `po_1TjTPX`, `po_1TjUCp`)

---

## 3. Implementation method

### 3A. Stripe API (per Connect account)

Use **Connect account update** on the **connected account** (not platform):

```typescript
await stripe.accounts.update(
  connectedAccountId, // e.g. acct_1ThTrEEXTz9Ab5Ic
  {
    settings: {
      payouts: {
        schedule: {
          interval: "manual",
        },
      },
    },
  },
);
```

**Stripe reference:** [Account update — settings.payouts.schedule](https://docs.stripe.com/api/accounts/update)  
**Supported `interval` values:** `manual`, `daily`, `weekly`, `monthly` (Express/Custom Connect).

**Verification read-back:**

```typescript
const account = await stripe.accounts.retrieve(connectedAccountId);
const interval = account.settings?.payouts?.schedule?.interval;
const isAutomatic = interval !== "manual";
```

### 3B. Proposed edge function: `admin-connect-payout-lockdown`

| Mode | Behaviour |
|------|-----------|
| `dry_run: true` / `verification_mode: true` | List accounts, log would-change, **no** `accounts.update` |
| `confirm_lockdown: true` | Apply manual schedule after safety checks |
| `ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED` | **Not required** — this is Connect **settings**, not a payout transfer |

**Reuse:** Extend `_shared/payoutExecutionGate.ts` pattern for dry-run / verification exit before any Stripe mutation.

### 3C. New-driver default (prevent regression)

| Hook | Action |
|------|--------|
| `driver-stripe-onboard` / `stripe-onboard-driver` (drive-hub-buddy) | After `accounts.create` or on onboarding complete webhook, set `schedule.interval = manual` |
| Stripe `account.updated` webhook (optional) | Alert if `interval !== manual` on ONECAB-linked accounts |

### 3D. DB audit table (recommended)

Migration: `stripe_connect_payout_schedule_audit`

```sql
CREATE TABLE public.stripe_connect_payout_schedule_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid NOT NULL REFERENCES drivers(id),
  stripe_account_id text NOT NULL,
  action text NOT NULL, -- 'LOCKDOWN_DRY_RUN' | 'LOCKDOWN_APPLIED' | 'VERIFY_READ'
  before_interval text,
  before_delay_days int,
  after_interval text,
  after_delay_days int,
  in_flight_payout_ids jsonb,
  connect_available_pence int,
  connect_pending_pence int,
  performed_by uuid,
  dry_run boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

RLS: service_role write; admin read.

---

## 4. Safety checks before changing Stripe settings

Execute **in order** for each Connect account:

| # | Check | How |
|---|-------|-----|
| 1 | **Belongs to ONECAB driver** | `drivers.stripe_account_id = :acct` AND `approval_status` known |
| 2 | **Not platform account** | Reject if `acct` equals platform account ID from `accounts.retrieve()` without Connect header |
| 3 | **In-flight payouts** | `stripe.payouts.list({ status: 'pending' }, { stripeAccount })` + `in_transit` — log IDs; **do not cancel** unless Stripe supports and ops approves |
| 4 | **Before snapshot** | `accounts.retrieve` → schedule interval, delay_days; `balance.retrieve` → available/pending |
| 5 | **Dry-run first** | Phase 3D.3 deployment: mandatory dry-run pass for MK0001 + MK0002 |
| 6 | **After snapshot** | Re-read account settings; assert `interval === 'manual'` |
| 7 | **Audit row** | Insert into `stripe_connect_payout_schedule_audit` (or append-only log) |

### MK0001 in-flight (must not disrupt)

| Payout | Amount | Status | Ledger | payout_item | Action |
|--------|--------|--------|--------|-------------|--------|
| `po_1TjdXrEXTz9Ab5Ic7xa29zfU` | £2.78 | **pending** | Yes | Yes | **Let complete** — switching to manual does not cancel existing pending payouts |

### Abort lockdown if

- `stripe_account_id` not found in `drivers` table  
- Unexpected third Connect account appears without ops sign-off  
- Stripe API error on read-back verification  

---

## 5. Backfill / sync rule (pre-lockdown)

Before applying manual schedule (or immediately after for in-flight items):

### Rule A — In-flight pending payouts

| Payout | Driver | Required action |
|--------|--------|-----------------|
| `po_1TjdXr…` (£2.78, pending) | MK0001 | **Monitor completion** — already in ledger + `payout_items`. On `paid`, verify wallet recalc. **No new debit needed.** |

### Rule B — Historical auto orphans (already paid)

| Payout | Driver | Ledger | payout_item | Action |
|--------|--------|--------|-------------|--------|
| `po_1TjTPX…` (£16.93) | MK0001 | Yes | No | Documented — no re-lockdown action |
| `po_1TjUCp…` (£56.41) | MK0002 | Partial (Option 3) | No | Documented — no re-lockdown action |

### Rule C — Pre-lockdown orphan discovery (read-only first)

1. Invoke `admin-sync-payout-ledger` with `discover_orphans: true` per driver (**read-only dry-run mode recommended** — add if not present)  
2. Any **paid** Connect payout without ledger row → backfill via existing `insert_payout_ledger_debit_if_missing` **before** first controlled admin payout (separate approved phase)  
3. Any **pending** auto payout discovered → document; consider cancel only with Stripe support guidance (Connect payouts generally **cannot** be cancelled once in transit)

### Rule D — Pending Connect balance after lockdown

MK0001 **£9.54 pending** on Connect after manual lockdown:

- Stays on Connect until **admin payout engine** initiates transfer/payout  
- Does **not** auto-sweep to bank  
- Visible in admin Connect balance panel (§6)

---

## 6. Admin visibility

### Current state (gap analysis)

| Field | Shown today? | Location |
|-------|--------------|----------|
| `stripe_account_id` | Yes | `DriverDetailsDialog.tsx` |
| `payouts_enabled` (DB flag) | Yes | Driver details |
| **Connect payout schedule (auto/manual)** | **No** | — |
| **Connect available / pending balance** | Partial | Per-driver SSOT / finance reconciliation (platform-weighted) |
| **Next payout / in-flight payout** | Partial | `payout_items`, Monday diagnostics |
| **Last ledger sync status** | Partial | `admin-sync-payout-ledger` manual invoke |

### Required additions (3D.3 implementation phase)

**New admin panel:** `ConnectPayoutStatusCard` on Driver Wallet / Settlements / Driver details

| Display | Source |
|---------|--------|
| Payout mode | `accounts.retrieve` → `settings.payouts.schedule.interval` |
| Automatic? | `interval !== 'manual'` |
| Connect available | `balance.retrieve({ stripeAccount })` |
| Connect pending | same |
| In-flight payout(s) | `payouts.list({ status: 'pending' \| 'in_transit' })` |
| Last orphan sync | `stripe_connect_payout_schedule_audit` + last `admin-sync-payout-ledger` run |

**Edge function:** `admin-connect-payout-status` (read-only GET, admin auth) — wraps Stripe reads + DB driver match.

**Alerting (optional P1):** Badge **“Auto-payout ENABLED”** (red) on driver row when `interval !== manual`.

---

## 7. Tests / verification (post-lockdown)

### 7A. Stripe settings verification (MK0001, MK0002)

| Check | Expected |
|-------|----------|
| `settings.payouts.schedule.interval` | **`manual`** |
| `automatic_payouts_enabled` (3D.2 definition) | **`false`** |
| No new `automatic: true` Connect payouts after lockdown date | Pass (monitor 7 days) |

### 7B. Balance visibility

| Check | Expected |
|-------|----------|
| MK0001 Connect available/pending readable in admin | £0.87 / £9.54 (or current) |
| MK0002 Connect available/pending | £0.00 / £0.00 |

### 7C. Admin payout path (no movement)

| Check | Expected |
|-------|----------|
| `admin-driver-payout` + `verification_mode: true` | 200, simulated, **no** Stripe objects |
| `admin-weekly-monday-settlement` + `verification_mode: true` | 200, **no** batches |
| `ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED` | **`false`** (unchanged) |

### 7D. Script

Extend `scripts/phase3d1-payout-safety-verification.ts` or add `scripts/phase3d3-connect-lockdown-verification.ts`:

1. Call `phase-3d2-stripe-balance-audit` (read-only)  
2. Assert all Connect accounts `interval === 'manual'`  
3. Assert zero `pending`/`in_transit` payouts with `automatic: true` created after lockdown timestamp  
4. Run 3D.1 dry-run suite  

---

## 8. Execution sequence (recommended)

```
Phase 3D.3a — Plan sign-off (this document)
    ↓
Phase 3D.3b — Deploy read-only admin-connect-payout-status + audit table migration
    ↓
Phase 3D.3c — Dry-run lockdown edge function (MK0001, MK0002)
    ↓
Phase 3D.3d — Confirm po_1TjdXr in-flight handling (monitor only)
    ↓
Phase 3D.3e — Apply manual schedule (Ahmed approval) — accounts.update × 2
    ↓
Phase 3D.3f — Verify + 3D.1 dry-run re-run
    ↓
Phase 3D.3g — Update driver onboarding default to manual (prevent regression)
    ↓
Phase 3D.4 — First controlled payout (separate phase; execution flag still false until approved)
```

**Constraints honoured in 3D.3 plan:**

- No real payouts during lockdown apply (settings change only)  
- In-flight `po_1TjdXr` completes as normal bank payout — not blocked  
- No new ledger debits during lockdown apply  
- No payout batches during lockdown apply  
- `ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED` remains **false**

---

## 9. GO / NO-GO matrix

### Disable auto-payouts?

| | |
|--|--|
| **Recommendation** | **GO** |
| **Reason** | Eliminates primary orphan path (`po_1TjTPX` / `po_1TjUCp` pattern). Required for ledger-controlled payouts. |
| **Risk if skipped** | Any Connect credit can auto-sweep without admin batch / ledger |

### Deploy manual payout-only policy?

| | |
|--|--|
| **Recommendation** | **GO** (after §5 in-flight handling) |
| **Prerequisite** | Ahmed approval for Stripe settings change on 2 accounts |
| **Blocker** | None technical — `po_1TjdXr` is manual and already ledger-linked |

### First controlled payout readiness?

| | |
|--|--|
| **Recommendation** | **NO-GO until 3D.3e verified** |
| **Remaining after 3D.3** | Negative wallets (MK0001 −£2.78, MK0002 −£23.00), 3D.1 execution lock, Ahmed approval for `ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED=true`, staged single-driver test |

---

## 10. Related artifacts

| Document | Relevance |
|----------|-----------|
| `docs/PHASE_3D2_STRIPE_BALANCE_AUDIT.md` | Current auto-payout evidence |
| `docs/PHASE_3D1_PAYOUT_SAFETY_LOCKDOWN_REPORT.md` | Admin execution gates |
| `supabase/functions/phase-3d2-stripe-balance-audit/index.ts` | Read-only Connect inventory |
| `supabase/functions/admin-sync-payout-ledger/index.ts` | Orphan discovery backfill |
| `supabase/functions/_shared/payoutExecutionGate.ts` | Dry-run / verification pattern |

---

## Stop condition

This document is the **Phase 3D.3 plan deliverable only**. No Stripe settings were changed. No payouts, ledger debits, or batches were created.

**Next action:** Ahmed sign-off → implement `admin-connect-payout-lockdown` (dry-run) → apply manual schedule on MK0001 + MK0002.
