# P0 Africa Commission Wallet — Phase 3

**Status:** Closed (driver read-only page, internal test drivers only).

Primary driver repo: `drive-hub-buddy`. Shared DB: `thazislrdkjpvvghtvzo`.

## Scope (done)

- Driver route `/commission-wallet` — balances + recent ledger (read-only; Card/Badge UI only)
- Route gate: redirects home when not visible or fetch fails (no flash of forbidden content)
- SideDrawer link only when access gate passes (shared React Query key + staleTime with page)
- Edge: `driver-commission-wallet-summary` (verified JWT via `auth.getUser`; no ledger writes)
- Column: `drivers.commission_wallet_test_access` (default **false**)
- **Lock:** trigger blocks driver self-grant/revoke of `commission_wallet_test_access` (admin role or service_role only)
- Admin edge: `admin-set-commission-wallet-test-access` — **get** (omit `enabled`) and **set** (boolean `enabled`); page RBAC `commission-wallet`
  - Finance managers use this edge for both read and write (no direct `drivers` SELECT — RLS is admin-only)
  - Admin UI parses non-2xx Bodies via `FunctionsHttpError.context.json()`, Retry on load failure, ignores stale set responses
- UK short-circuit: SideDrawer skips summary edge when test access is false
- SSOT: `shouldShowDriverCommissionWalletPage` + `planDriverCommissionWalletPageAccess` require:
  1. SA `DRIVER_COLLECTED_COMMISSION_WALLET` + `commission_wallet_enabled`
  2. `commission_wallet_test_access = true`
- Admin Commission Wallet page: Phase 3 test access toggle for a driver ID
- UK `/wallet` unchanged

## Isolation

- Never writes `driver_wallet_ledger` or commission ledger from driver edge
- No Withdraw / Cash Out / Transfer / Top-up / Dispatch reserve in Phase 3
- Non-test drivers and PLATFORM_COLLECTED SAs: page hidden + route redirects home
- Drivers cannot self-enable the page via own-profile UPDATE RLS

## Enable a test driver

1. Enable Commission Wallet on the Africa SA (Admin → Services → Pricing)
2. Admin → Commission Wallet → enter driver UUID → toggle **Phase 3 test access** ON  
   (uses `admin-set-commission-wallet-test-access`; SQL via service role also works)
3. Driver app: SideDrawer → Commission Wallet

## Not Phase 3

Provider top-up, campaigns, dispatch reserve, trip deduction, finance revenue, full Africa rollout.
