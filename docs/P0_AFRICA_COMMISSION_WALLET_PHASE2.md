# P0 Africa Commission Wallet — Phase 2

**Status:** Delivered (admin surface + credit). Dispatch reserve still **disabled**.

Primary admin repo: `admin-new`. Shared DB project: `thazislrdkjpvvghtvzo`.

## Scope (done)

- Admin page `/commission-wallet` — overview cards, driver balances, recent ledger, admin audit, Add Credit
- SA Pricing → Offers & Payment → Commission Wallet (Africa) enable/config (self-save)
- Edges: `admin-commission-wallet-credit`, `admin-commission-wallet-overview`
- Migrations: audit table, RBAC, audit ledger uidx, welcome credit uidx
- SSOT: credit plan, welcome gates, assignment gate, overview card aggregation, correction-safe idempotency keys
- Roles UI + edge RBAC via `requirePageAccess('commission-wallet')`
- Idempotency before welcome policy (replay-safe)
- Service-role blocked on credit + overview (JWT staff/admin only)
- Driver↔SA assignment enforced; welcome policy + DB unique index
- Overview full-history aggregates; region-scoped audit (empty region does not fall open)
- Currency required on credit when SA has no wallet/region currency

## Roles

- `super_admin` / `admin` / `finance_manager` can access `/commission-wallet` and post credits
- SA enable/config on Pricing remains **admin/super_admin** (finance_manager credits only; intentional)

## Isolation

- Writes **only** `driver_commission_wallet_ledger` + `commission_wallet_admin_audit`
- Never writes `driver_wallet_ledger`, payout intents, or payment sessions
- Credits rejected unless Africa model **and** `commission_wallet_enabled = true`
- `commission_reserve_enabled` unlocked in admin UI (see Phase 6)

## Not Phase 2

Dispatch reserve, booking skip-preauth, provider top-ups, trip deduction, driver app page, finance revenue reporting.
