## Context

Two admin UI paths still invoke edge functions that were permanently removed during the Stripe → Revolut migration. Because your project rule is "delete legacy code, never leave fallbacks", the fix is to remove these UI paths entirely rather than re-add Stripe backends.

- `admin-edit-trip-fare` — deleted. Called by **Edit Fare**, **Waive extra amount**, **Internal adjustment** in `PaymentControlsCard`.
- `stripe-onboard-driver` — deleted. Called by **Send onboarding link** in `DriverDetailsDialog`.
- `admin-sync-trip-payment-from-stripe` — still exists as a file but is Stripe-only and the UI already hard-codes `canSyncStripe = false`. It is dead code in a Revolut-only world.

## Changes

### 1. `src/components/payment/PaymentControlsCard.tsx`
- Delete `syncStripeMutation` (Stripe-only, unreachable via `canSyncStripe = false`).
- Delete `openWaive`, `openInternalAdjustment`, and the `'edit'` branch that maps to `admin-edit-trip-fare` in `actionMutation`.
- Remove the "Edit Fare" button (line ~863) and the platform-adjustment / waive entry points wired through `FinanceTripActionsPanel` (`onPlatformAdjustment`, `onResyncStripe`, `onRepairSettlement`).
- Remove the `FinanceRecoveryAction` values `'waive'` and `'internal_adjustment'` and the `initialAction` branches that call the removed handlers.
- Keep capture / refund / cancel / extra_payment (they call live Revolut-aware functions).

### 2. `src/components/finance/FinanceTripActionsPanel.tsx`
- Drop the props `onResyncStripe`, `onRepairSettlement`, `onPlatformAdjustment` and any buttons that render them. Fare corrections now happen through the Payment Sessions recovery flow only.

### 3. `src/components/drivers/DriverDetailsDialog.tsx`
- Remove `sendOnboardingLink` and its button. Driver payout onboarding is Revolut-side; there is no equivalent admin-triggered onboarding link right now.
- If a placeholder is needed, show a short note pointing admins to the Payout Ledger / driver payout destination flow.

### 4. Delete unused edge function
- `supabase/functions/admin-sync-trip-payment-from-stripe/` — remove the directory. It has no live caller after step 1.

### 5. Search sweep
- `rg "admin-edit-trip-fare|stripe-onboard-driver|admin-sync-trip-payment-from-stripe"` after the edits to confirm zero remaining references (source, tests, docs — docs may stay for history).

## Verification

- Typecheck passes.
- Manual: open a trip's payment controls → Edit Fare / Waive / Internal Adjustment buttons are gone; capture / refund still work.
- Manual: open a driver in Driver Details → no "Send onboarding link" button.
- `rg` sweep returns 0 code references.

## Out of scope

- Building a Revolut-native replacement for admin-side fare editing or driver payout onboarding link generation. Those are new features and should be scoped separately if needed.
