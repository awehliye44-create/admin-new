# Digital-Only Enforcement — ONECAB (Admin project)

This project is the **Admin panel**. Customer app and Driver app live in separate projects; changes there must be made in those repos. This plan enforces the rule inside Admin + shared backend (edge functions + DB constraints) that this repo owns.

## Scope in this repo

1. **Backend hard rule (DB + edge functions)** — reject any new trip/booking whose `payment_method` is cash. Historical rows stay untouched.
2. **Admin UI purge** — remove cash from all active operational surfaces (booking creation, dispatch, fare tools, service-area payment method configuration).
3. **Finance surfaces** — exclude cash from current Financial Reconciliation totals, alerts, wallet, settlement, payouts, debt recovery. Cash rows in Trip History stay as "Historical legacy trip" (already implemented via `isHistoricalLegacyCashTrip`).
4. **Deletions** — permanently delete cash-only code paths (per user's cleanup policy). No commented fallbacks.

Out of scope: Customer App and Driver App code (separate projects — user must apply the same rule there).

## Changes

### 1. Database (migration)

- Add CHECK constraint on `public.trips.payment_method`:
  - New rows must satisfy `payment_method IN ('card','wallet','apple_pay','google_pay','revolut')` (aligned with `StripeDigitalPaymentMethodType` used in `useServiceAreaPaymentMethods`).
  - Implemented as a **BEFORE INSERT trigger** (not a CHECK constraint on the column) so historical `cash` rows remain valid and only new inserts are blocked. Follows project rule "validation triggers over CHECK".
- Add same trigger on `public.ride_offers` / `public.trip_change_requests` if they carry `payment_method`.
- Remove `'cash'` from `public.region_payment_methods` / `public.service_area_payment_methods` active seed rows (data update via insert tool, not migration).

### 2. Admin edge functions

Audit and update these to reject cash on new writes:
- `create-payment-intent`
- `admin-request-extra-payment`
- `admin-capture-trip-payment`, `admin-cancel-trip-payment`, `admin-refund-trip-payment`
- Any booking-creation function (admin manual dispatch)
- `record-financial-outcome` — exclude cash from new ledger entries; historical cash never generates new commission/debt-recovery entries.

Delete (do not stub):
- Cash-only debt recovery paths in wallet ledger writers (`DEBT_RECOVERY` from cash cannot be created for new trips; existing rows preserved).
- Cash shortfall computation on new trips.

### 3. Admin UI

**Booking / Dispatch:**
- Remove `cash` option from any admin "new booking" or "dispatch" form.
- Remove cash filter chips from Trips / Dispatch pages.

**Service Area config:**
- `ServiceAreaPaymentConfig` / `useServiceAreaPaymentMethods` already digital-only (`StripeDigitalPaymentMethodType`). Verify no cash toggle remains; delete any residual.

**Finance pages:**
- Financial Reconciliation totals: exclude `payment_method='cash'` from all current-period aggregations (KPIs, drivers tab, trips tab, alerts).
- Wallet / Payouts / Settlement: exclude cash from current calculations.
- Trip History: keep the existing "Historical legacy trip — read-only" treatment; remove any remaining cash-specific action buttons on historical rows (view-only).

**Alerts / debt:**
- Remove cash-outstanding alert rules from active detection.

### 4. Historical cash trips (unchanged behaviour)

- Continue to render as "Historical legacy trip" via existing `isHistoricalLegacyCashTrip` / `historicalLegacyTripPaymentLabel` helpers.
- Not counted in current reconciliation, wallet, or payouts.
- No shortfall banners (already fixed).

## Technical details

**Trigger sketch:**

```sql
create or replace function public.enforce_digital_only_payment_method()
returns trigger language plpgsql as $$
begin
  if new.payment_method is not null
     and lower(new.payment_method) not in ('card','wallet','apple_pay','google_pay','revolut')
  then
    raise exception 'ONECAB is digital-only: payment_method % is not allowed for new trips', new.payment_method
      using errcode = 'check_violation';
  end if;
  return new;
end$$;

create trigger trg_trips_digital_only
  before insert on public.trips
  for each row execute function public.enforce_digital_only_payment_method();
```

**Files likely touched (Admin repo):**
- `supabase/migrations/*` (new trigger migration)
- `supabase/functions/create-payment-intent/index.ts`
- `supabase/functions/admin-request-extra-payment/index.ts`
- `supabase/functions/record-financial-outcome/index.ts`
- `src/pages/FinancialReconciliation.tsx` + `src/components/finance/*` (cash exclusion in aggregations, remove cash filters)
- `src/pages/TripHistory.tsx` (verify no cash action buttons on historical rows)
- Any admin "new booking / dispatch" component that still lists `cash`
- Delete: cash-shortfall helpers, cash debt-recovery writers scoped to new trips

## Verification

- Attempt to insert a `payment_method='cash'` trip → DB rejects.
- Admin booking form does not offer cash.
- Financial Reconciliation totals unchanged when only historical cash exists in range (they are excluded).
- Trip History still shows historical cash rows labelled "Historical legacy trip", no shortfall, no actions.
- Search: `rg -n "'cash'|\"cash\"" src/ supabase/functions/` returns only historical/read-only references.

## Out-of-scope reminder

Customer App and Driver App enforcement must be done in their own repos. This plan only covers Admin + shared backend in this repo.
