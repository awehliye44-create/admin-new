# P0 Africa Commission Wallet — Phase 6

**Status:** Delivered (dispatch eligibility + accept-time commission reserve).

Primary repos: `drive-hub-buddy` (dispatch + accept trigger), `admin-new` (reserve toggle), shared DB `thazislrdkjpvvghtvzo`.

## Scope (done)

- SSOT: `planCommissionWalletDispatchEligibility`, `planCommissionWalletReserve`, `planCommissionWalletReserveRelease`, fare/bps helpers
- Migration: `20260831700000_commission_wallet_phase6_dispatch_reserve.sql`
  - `reserve_driver_commission_wallet` / `release_driver_commission_wallet`
  - `driver_commission_wallet_usable_balance_minor`
  - Trip `driver_id` assignment trigger — reserve on assign, release on clear/reassign
- Gap-close: `20260831710000_commission_wallet_phase6_gap_close.sql`
  - Trigger also fires on **INSERT** with `driver_id` (manual assign / create-trip paths)
  - SQL `dispatch_trip_offers` soft gate via `driver_passes_commission_wallet_dispatch_gate` (Scan & Go + emergency)
  - SA CHECK: reserve cannot be on unless wallet enabled under DRIVER_COLLECTED
- Gap-close pass 2: `20260831720000_commission_wallet_phase6_reserve_error_code.sql`
  - Reserve failures raise `INSUFFICIENT_COMMISSION_WALLET_BALANCE: …` for edge mappers
  - `accept-offer` / admin reassign / create-trip-request / scheduled commitment map or soft-check that code
  - `customer-fare-decision` ACCEPT maps the same code; lost-property return-ride assign checks gate + errors before booking case
  - `stop-workflow` late assign + `lost-property-transition` ACCEPT_RETURN check reserve failures (no silent assign)
  - `scheduled-checkin` soft-checks CW when promoting confirmed-only → `driver_id`
  - ManualTrip / ActiveTrips surface clear ops toasts on insufficient balance
  - Legacy admin `accept-trip` maps the reserve error code
- `auto-dispatch`: soft gate when `shouldApplyCommissionWalletDispatchGate` — permanent reject `insufficient_commission_wallet_balance` (fail-closed on SA/ledger load errors)
- Admin: unlock `commission_reserve_enabled` (forced off when wallet disabled / PLATFORM_COLLECTED)

## Behaviour

| Event | Action |
|-------|--------|
| Dispatch (CW + reserve on) | Offer only if usable ≥ estimated fare × commission bps |
| Accept / stacked accept / INSERT assign | Same-txn reserve via trip `driver_id` assignment trigger |
| Cancel / rematch / clear driver | Release reserve (ledger `COMMISSION_RESERVE_RELEASE`, no deduction) |
| PLATFORM_COLLECTED / reserve off | All paths no-op |

Required reserve = `round(fare_minor × commission_rate_bps / 10000)`.  
Fare preference: final customer → final → accepted offer → estimated total → estimated_fare×100.

Scheduled accept holds `confirmed_driver_id` with `driver_id` null until commitment; reserve runs when commitment sets `driver_id` (soft gate still applies at offer time via auto-dispatch / scheduled-dispatch).

## Isolation

- Never writes `driver_wallet_ledger`
- UK PLATFORM_COLLECTED dispatch / accept unchanged when gate off
- Locked accept **client** files untouched — reserve is SQL trigger inside `accept_ride_offer` / `accept_stacked_ride` transactions
- No Phase 7 completion deduction / Finance revenue → **see Phase 7 doc** (`P0_AFRICA_COMMISSION_WALLET_PHASE7.md`)

## Not Phase 6

Trip completion commission deduction, reserve→deduction conversion, fixed platform charge add-on, mid-negotiation reserve recalculation (reserve uses post-accept finalized fare).
