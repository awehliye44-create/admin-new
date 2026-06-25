# Stripe Connect — Admin Driver Profile UI Audit

**Date:** 2026-06-24  
**Surface:** Admin → Drivers → Driver Details → Overview → **Stripe Connect**  
**Component:** `src/components/drivers/DriverDetailsDialog.tsx`  
**Proof driver:** MK0001 (Ahmed Osman) — `acct_1ThTrEEXTz9Ab5Ic`  
**Status:** Read-only audit — no code changes

---

## Executive summary

The Stripe Connect section is **misleading for fully onboarded drivers** because the **“Resend Onboarding Link” button is always shown** whenever `stripe_account_id` exists. There is **no conditional** tied to onboarding completion, capability flags, or outstanding Stripe requirements.

For MK0001 the UI correctly shows **Connected** and **Payouts: Enabled** (DB and live Stripe agree), but still renders **Resend Onboarding Link** — implying incomplete onboarding when onboarding is complete.

**Root cause:** UI bug (unconditional button), not stale Stripe data for MK0001.

---

## 1. Current rendering logic

### Data source

| Item | Detail |
|------|--------|
| Page | `src/pages/Drivers.tsx` |
| Load query | `supabase.from('drivers').select('*')` |
| Dialog | `DriverDetailsDialog` receives full `drivers` row as `driver` prop |
| Stripe fields used | `stripe_account_id`, `onboarding_complete`, `payouts_enabled` |
| Stripe fields available but **not shown** | `charges_enabled` |

### Status badge

```tsx
{driver.stripe_account_id ? (
  <Badge>
    {driver.onboarding_complete ? 'Connected' : 'Incomplete'}
  </Badge>
) : (
  <Badge>Not Connected</Badge>
)}
```

| Condition | Badge |
|-----------|-------|
| No `stripe_account_id` | **Not Connected** (red) |
| Account ID + `onboarding_complete === true` | **Connected** (green) |
| Account ID + `onboarding_complete === false` | **Incomplete** (yellow) |

**Not used for badge:** `charges_enabled`, `payouts_enabled`, Stripe `requirements.currently_due`, live Stripe API.

### Account details grid (when `stripe_account_id` present)

| Field shown | Source |
|-------------|--------|
| Account ID | `driver.stripe_account_id` |
| Payouts | `driver.payouts_enabled` → “Enabled” / “Disabled” |

**Not shown:** Charges enabled, details submitted, requirements due, payout schedule, last sync time.

### Onboarding button — **the bug**

```tsx
<Button onClick={sendOnboardingLink} ...>
  {driver.stripe_account_id ? 'Resend Onboarding Link' : 'Send Onboarding Link'}
</Button>
```

| Rule today | Behaviour |
|------------|-----------|
| Button visibility | **Always rendered** for every driver |
| Label | `Send…` if no account ID; `Resend…` if account ID exists |
| Gating | **None** — no check on `onboarding_complete`, `payouts_enabled`, `charges_enabled`, or requirements |

`sendOnboardingLink()` calls edge `stripe-onboard-driver` with `{ driver_id }`, which always creates an Stripe `account_links` object with `type: "account_onboarding"` (even when the account already exists and is active).

---

## 2. Stripe status fields — definitions and writers

### Database (`drivers` table)

| Column | Meaning in ONECAB | Updated by |
|--------|-------------------|------------|
| `stripe_account_id` | Stripe Connect Express account ID | `stripe-onboard-driver` (create), driver onboarding flows |
| `onboarding_complete` | **`details_submitted`** from Stripe | `stripe-webhook` → `account.updated` |
| `charges_enabled` | Stripe `charges_enabled` | `stripe-webhook` → `account.updated` |
| `payouts_enabled` | Stripe `payouts_enabled` | `stripe-webhook` → `account.updated` |

Webhook handler (`drive-hub-buddy/supabase/functions/stripe-webhook/index.ts`):

```typescript
onboarding_complete: account.details_submitted === true,
payouts_enabled: account.payouts_enabled === true,
charges_enabled: account.charges_enabled === true,
```

**Note:** `onboarding_complete` is **not** `charges_enabled && payouts_enabled`. A driver can have `details_submitted` with capabilities still pending (badge may say Connected while payouts show Disabled).

### Live Stripe (admin-connect-payout-status)

Used on Financial Reconciliation → Connect Balance tab, **not** on Driver Profile.

| Field | MK0001 live (2026-06-24) |
|-------|--------------------------|
| `connect_account_status` | `active` |
| `charges_enabled` | `true` |
| `payouts_enabled` | `true` |
| `stripe_account_id` | `acct_1ThTrEEXTz9Ab5Ic` |

### Shared eligibility helper (not used by Driver Profile UI)

`derivePayoutEligibility()` in `supabase/functions/_shared/onecabFinanceLedger.ts`:

```typescript
stripe_connected = stripe_account_id && onboarding_complete
payout_eligible = stripe_connected && payouts_enabled && no requirements_currently_due
```

Driver app uses `driver-stripe-refresh-status` for live Stripe sync; **admin Driver Profile does not refresh from Stripe** — it only reads cached DB columns from initial `select('*')`.

---

## 3. Production evidence — MK0001

### Database (`drivers`)

```json
{
  "driver_code": "MK0001",
  "stripe_account_id": "acct_1ThTrEEXTz9Ab5Ic",
  "onboarding_complete": true,
  "payouts_enabled": true,
  "charges_enabled": true
}
```

### Live Stripe (via `admin-connect-payout-status`)

```json
{
  "connect_account_status": "active",
  "charges_enabled": true,
  "payouts_enabled": true
}
```

### UI interpretation vs reality

| UI element | MK0001 display | Accurate? |
|------------|----------------|-----------|
| Badge “Connected” | Yes | ✓ (`onboarding_complete`) |
| Payouts “Enabled” | Yes | ✓ (DB + Stripe) |
| Account ID | Shown | ✓ |
| **Resend Onboarding Link** | Shown | **✗ Misleading** — onboarding complete, account active |

---

## 4. Why the button still renders

**Single reason:** The component has **no branch** to hide or replace the button when onboarding is complete.

The label `"Resend Onboarding Link"` is chosen solely because `stripe_account_id` is truthy. That is independent of:

- `onboarding_complete`
- `charges_enabled`
- `payouts_enabled`
- Stripe requirements / restrictions

This matches the screenshot: Connected + Payouts Enabled + Resend button simultaneously.

---

## 5. Edge cases

| Scenario | Badge | Payouts row | Button today | Correct UX |
|----------|-------|-------------|--------------|------------|
| No Stripe account | Not Connected | hidden | Send Onboarding Link | ✓ Send |
| Account created, onboarding not submitted | Incomplete | often Disabled | Resend Onboarding Link | ✓ Resend |
| **Fully connected (MK0001)** | Connected | Enabled | **Resend** | **✗ Hide or replace** |
| `onboarding_complete` true, `payouts_enabled` false | Connected | Disabled | Resend | Show **Needs attention** + Refresh; optional re-onboard |
| `charges_enabled` false | Connected* | varies | Resend | Show charges status; Refresh |
| Requirements `currently_due` non-empty | Connected* | may be Enabled | Resend | Show **Requirements due**; Re-open onboarding |
| Restricted (`disabled_reason`) | Connected* | Disabled | Resend | Show restriction; link to Stripe dashboard |

\*Badge still “Connected” if `details_submitted` — may overstate readiness.

### `stripe-onboard-driver` on completed accounts

- Does **not** check whether onboarding is already complete.
- Always requests `account_links` with `type: "account_onboarding"`.
- Stripe may still return a URL (account update flow), but admin label **“Resend Onboarding Link”** implies the driver never finished — wrong for MK0001.

### Stale DB risk

Driver Profile never calls `driver-stripe-refresh-status` or live Stripe. If webhooks lag, badge/payouts can be stale until page reload after webhook. **Not the MK0001 issue** (DB and live Stripe agree).

---

## 6. Recommended production behaviour

### A. Define “fully connected” for admin UI

Recommend aligning with `derivePayoutEligibility` + Connect Balance `active` status:

```text
fully_connected =
  stripe_account_id
  AND onboarding_complete          // details_submitted
  AND charges_enabled
  AND payouts_enabled
  AND connect_account_status === 'active'   // no requirements_due / disabled_reason
```

Split **display** into:

| State | Badge | Subtitle |
|-------|-------|----------|
| Not connected | Not Connected | No Stripe account |
| Onboarding incomplete | Incomplete | Account created — onboarding not submitted |
| Connected, needs attention | Needs attention | e.g. payouts disabled, requirements due |
| Fully connected | Connected | Charges on · Payouts on |

### B. Button rules

| State | Primary actions |
|-------|-----------------|
| No account | **Send Onboarding Link** |
| Incomplete onboarding | **Resend Onboarding Link** |
| Needs attention | **Refresh Stripe Status** + **Re-open Stripe Onboarding** (admin) |
| **Fully connected** | **Hide** “Resend Onboarding Link” |

Replace with (fully connected):

1. **View Stripe Account** — `stripe.accounts.createLoginLink` (Express dashboard); open in new tab.
2. **Refresh Stripe Status** — admin edge that retrieves account + updates `drivers` row (mirror `driver-stripe-refresh-status` or reuse).
3. **Re-open Stripe Onboarding** — only under “Needs attention” or explicit admin override; label must not say “Resend” when status is Connected.

### C. Display additions

Show in the Stripe Connect card:

- **Charges:** Enabled / Disabled (`charges_enabled`)
- **Last synced:** timestamp if refresh endpoint added
- **Requirements:** count or list when `currently_due.length > 0` (from live Stripe or cached JSON column)

### D. Implementation sketch (minimal)

```tsx
const fullyConnected =
  driver.stripe_account_id &&
  driver.onboarding_complete &&
  driver.charges_enabled &&
  driver.payouts_enabled;

// Primary CTA
{!driver.stripe_account_id && <Button>Send Onboarding Link</Button>}
{driver.stripe_account_id && !driver.onboarding_complete && (
  <Button>Resend Onboarding Link</Button>
)}
{fullyConnected && (
  <>
    <Button variant="outline">View Stripe Account</Button>
    <Button variant="outline">Refresh Stripe Status</Button>
  </>
)}
{driver.stripe_account_id && driver.onboarding_complete && !fullyConnected && (
  <>
    <Button variant="outline">Refresh Stripe Status</Button>
    <Button variant="outline">Re-open Stripe Onboarding</Button>
  </>
)}
```

### E. Non-goals for this audit

- No change to payout SSOT or Connect Balance tab.
- No change to `ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED`.
- Driver app onboarding flows unchanged.

---

## 7. File reference map

| Role | Path |
|------|------|
| Admin UI (bug) | `admin-new/src/components/drivers/DriverDetailsDialog.tsx` (~729–782) |
| Driver list / data load | `admin-new/src/pages/Drivers.tsx` (`select('*')`) |
| Admin onboarding link edge | `admin-new/supabase/functions/stripe-onboard-driver/index.ts` |
| DB Stripe field updates | `drive-hub-buddy/supabase/functions/stripe-webhook/index.ts` (`handleAccountUpdated`) |
| Driver live refresh | `drive-hub-buddy/supabase/functions/driver-stripe-refresh-status/index.ts` |
| Payout eligibility SSOT | `admin-new/supabase/functions/_shared/onecabFinanceLedger.ts` → `derivePayoutEligibility` |
| Live Connect status (finance tab) | `admin-new/supabase/functions/admin-connect-payout-status/index.ts` |

---

## 8. Acceptance criteria (post-fix)

For MK0001 (fully connected):

- [ ] Badge: **Connected**
- [ ] Charges: **Enabled** (visible)
- [ ] Payouts: **Enabled**
- [ ] **No** “Resend Onboarding Link” button
- [ ] **View Stripe Account** and/or **Refresh Stripe Status** available

For driver with account ID but `onboarding_complete === false`:

- [ ] Badge: **Incomplete**
- [ ] **Send / Resend Onboarding Link** visible

For driver with no `stripe_account_id`:

- [ ] Badge: **Not Connected**
- [ ] **Send Onboarding Link** only
