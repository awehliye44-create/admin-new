# Early Cash Out — Per Service Area Toggle

## Summary

Stripe Instant Payouts are not yet enabled for the ONECAB platform. This change adds a **per–service-area admin toggle** (`early_cashout_enabled`) so Instant Early Cash Out can stay hidden/disabled until Stripe enables the platform and ops turns it on area by area.

**Default: OFF** for all service areas.

Weekly payouts, wallet balance, earnings history, Stripe Connect onboarding, Financial Reconciliation, and admin manual payouts are **unchanged**.

---

## Database field added

| Table | Column | Type | Default | Notes |
|-------|--------|------|---------|-------|
| `service_areas` | `early_cashout_enabled` | `boolean NOT NULL` | `false` | Per-area driver instant cash out |

**Migration:** `20260827140000_service_area_early_cashout_enabled.sql`

Deployed to:

- `onecab-comfy-ride/supabase/migrations/`
- `drive-hub-buddy/supabase/migrations/`
- `admin-new/supabase/migrations/`

---

## Admin UI

**Location:** Admin Panel → Service Areas → **Offers & Payment** tab

**Component:** `ServiceAreaDriverWalletConfig` — card titled *Driver wallet — Early Cash Out*

**Toggle:** **Enable Early Cash Out**

**Helper text:**  
*"Controls whether drivers in this service area can use Instant Cash Out. Weekly payouts and wallet balance are not affected."*

**Persistence:** Saved with **Save Service Area** alongside tips and per-booking fee settings (`ServiceAreaPricing.tsx`).

---

## Driver app behaviour

When `early_cashout_enabled = false` for the driver’s service area:

| Still visible | Hidden / disabled |
|---------------|-------------------|
| Wallet balance | Instant cash out card + Cash Out button |
| Available / weekly payout amounts | Confirm cash out dialog |
| Transaction history | Stripe failure toasts for disabled cash out |
| Weekly payout date | |
| Stripe Connect / payout account status | |
| Activity this week | |

**Driver message (info banner):**  
*"Instant Cash Out is not available in your area yet. Your earnings will be paid on the normal payout schedule."*

**Service area resolution:** `drivers.service_area_id`, falling back to first `driver_service_areas` row. If none → treated as **disabled** (safe default).

**Wallet balance grid:** Second card retitled *Available for weekly payout*; instant-cash-out sublines removed.

---

## Backend enforcement

### `driver-early-cashout`

Checks `resolveEarlyCashoutEnabledForDriver()` **before** Stripe, ledger, or payout creation.

**Response when disabled:**

```json
{
  "error": "Instant Cash Out is not available in this service area.",
  "error_code": "EARLY_CASHOUT_DISABLED",
  "message": "Instant Cash Out is not available in this service area.",
  "driver_message": "Instant Cash Out is not available in this service area."
}
```

**HTTP status:** `403`

No payout, cashout row, Stripe payout, or ledger debit is created.

### `driver-wallet-summary`

Returns `early_cashout_enabled: boolean` and forces `can_cashout` / `cash_out_available` to `false` with `cash_out_blocked_reason: 'early_cashout_disabled'` when off.

---

## Affected files

| Area | File |
|------|------|
| Migration | `supabase/migrations/20260827140000_service_area_early_cashout_enabled.sql` |
| Shared | `drive-hub-buddy/shared/earlyCashout.ts` |
| Shared | `drive-hub-buddy/shared/driverWalletSummary.ts` |
| Edge shared | `drive-hub-buddy/supabase/functions/_shared/earlyCashoutServiceArea.ts` |
| Edge | `drive-hub-buddy/supabase/functions/driver-early-cashout/index.ts` |
| Edge | `drive-hub-buddy/supabase/functions/driver-wallet-summary/index.ts` |
| Admin | `admin-new/src/components/finance/ServiceAreaDriverWalletConfig.tsx` |
| Admin | `admin-new/src/pages/ServiceAreaPricing.tsx` |
| Driver model | `drive-hub-buddy/src/lib/driverWalletSummaryModel.ts` |
| Driver UI | `drive-hub-buddy/src/pages/Wallet.tsx` |
| Driver UI | `drive-hub-buddy/src/components/wallet/WalletBalanceGrid.tsx` |
| Tests | `drive-hub-buddy/src/lib/__tests__/driverWalletSummaryModel.test.ts` |

---

## Tests

### Unit tests (`driverWalletSummaryModel.test.ts`)

- `early_cashout_enabled: false` → `isCashOutEnabled()` false, blocked reason `early_cashout_disabled`
- `early_cashout_enabled: true` + sufficient balance → cash out eligible

### Manual acceptance (from spec)

1. Toggle OFF → driver wallet loads  
2. Toggle OFF → wallet balance shows  
3. Toggle OFF → transaction history shows  
4. Toggle OFF → Early Cash Out section hidden/disabled only  
5. Toggle OFF → `driver-early-cashout` returns `EARLY_CASHOUT_DISABLED`  
6. Toggle ON → Early Cash Out section appears  
7. Toggle ON → backend proceeds to normal settlement/Stripe checks  
8. Service Area A OFF / B ON → drivers follow their own setting  
9. Weekly payouts still visible  
10. Financial Reconciliation unchanged  

---

## Rollout plan

1. **Apply migration** to production Supabase (`service_areas.early_cashout_enabled`, default `false`).
2. **Deploy edge functions:** `driver-early-cashout`, `driver-wallet-summary`.
3. **Deploy admin panel** with Service Areas toggle (all areas remain OFF).
4. **Ship driver app** build with UI gating (optional if edge summary already blocks; app build improves UX).
5. **Verify** Milton Keynes / London drivers see info message, no cash out button, API returns `403 EARLY_CASHOUT_DISABLED`.
6. When Stripe enables Instant Payouts for ONECAB: enable toggle **per service area** in Admin → Service Areas → Offers & Payment.

---

## Rollback plan

1. **Immediate (no deploy):** Leave all toggles OFF — same as default; drivers cannot cash out.
2. **Disable feature globally:** Ensure no service area has `early_cashout_enabled = true`:

   ```sql
   UPDATE service_areas SET early_cashout_enabled = false;
   ```

3. **Revert edge functions** to previous version if a regression is found (toggle check is additive; revert removes server guard).
4. **Revert migration (optional, last resort):**

   ```sql
   ALTER TABLE service_areas DROP COLUMN IF EXISTS early_cashout_enabled;
   ```

   Only if column causes issues; dropping is safe — code treats missing/null as disabled.

5. **Revert driver app** to previous build if UI regression; wallet/weekly payout unaffected.

---

## When Stripe enables Instant Payouts

Set **Enable Early Cash Out = ON** for each service area that should offer instant payout. Drivers in that area will see the Instant cash out card and button; backend will run existing settlement and Stripe checks.
