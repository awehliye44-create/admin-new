# P0 Africa Commission Wallet — Phase 5

**Status:** Delivered (welcome auto-grant + promotional / top-up bonus campaigns).

Primary repos: `drive-hub-buddy` (driver), `admin-new` (admin CRUD), shared DB `thazislrdkjpvvghtvzo`.

## Scope (done)

- SSOT: `COMMISSION_WALLET_CAMPAIGN_TYPE`, `planCommissionWalletTopupBonus`, `planWelcomeCreditAutoGrant`, `planManualPromotionalCampaignCredit`, claim idempotency keys
- Migration: `commission_wallet_campaign_claims` + one-active top-up bonus index per SA
- Top-up confirm: after `TOP_UP_CREDIT`, auto `PROMOTIONAL_CREDIT` bonus + claim (initiate + webhook paths)
- Confirm replay backfills missing bonus claims; initiate/webhook return `bonus` metadata
- Admin edge: `admin-commission-wallet-campaigns` (`list` / `create` / `update` / `deactivate`) with type-specific field validation
- Admin credit: `PROMOTIONAL` requires active `MANUAL_PROMOTIONAL_CREDIT` `campaign_id`; welcome optionally links `WELCOME_CREDIT` campaign + claim
- Auto welcome: `tryGrantWelcomeCredit` after driver `approval_status → approved` (Drivers approve/edit/add + DriverDetailsDialog) and when an **already-approved** driver gains service areas — soft-fail, never blocks approval
- Credit edge welcome gate uses live `planWelcomeCreditAutoGrant` SSOT
- Driver summary: optional `active_topup_bonus` banner; top-up toast shows bonus when applied
- Overview: campaigns + claim counts
- SSOT: `validateCommissionWalletCampaignFields` for percent/fixed/window gates
- Top-up bonus caps counted from ledger (not claim table alone); claim upsert verified + retried

## Isolation

- Never writes `driver_wallet_ledger`
- PLATFORM_COLLECTED / UK `/wallet` / payouts untouched
- Campaign create/activate requires CW workflow enabled on SA
- Dispatch reserve / trip deduction still off
- Locked accept / preset pipelines untouched

## Welcome policy

SA columns remain SSOT (`welcome_credit_enabled`, `welcome_credit_amount_minor`, `welcome_credit_max_drivers`).  
Campaign type `WELCOME_CREDIT` is optional for audit / `campaign_id` linkage.

## Top-up bonuses

At most one active `TOP_UP_PERCENT_BONUS` or `FIXED_TOP_UP_BONUS` per SA.  
Percent formula: `round(topup × bonus_percent / 100)`, capped by `maximum_bonus_amount_minor`.

## Not Phase 5

Dispatch reserve, trip deduction, top-up reversal writers, stacking bonuses, marketing heads-up campaigns, driver self-claim UI, full Africa rollout.
