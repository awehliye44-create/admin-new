# Accepted authenticated SECURITY DEFINER warnings

Stopped 2026-09-12. ACL-only cleanup is exhausted. Do not draft or apply more warning SQL unless a finance, RLS/body-auth, or Edge/service-role refactor phase is explicitly approved. Next work is product and bug priority, not warning-count chasing.

## Accepted baseline

- Latest migration: `20261112150000` (`phase_location_search_rpc_execute_revoke`)
- anon SECURITY DEFINER warnings: 0
- authenticated SECURITY DEFINER warnings: 107
- errors: 0
- project: `ACTIVE_HEALTHY`
- Confirmed live at stop: latest migration `20261112150000`, authenticated executable SECURITY DEFINER 107, anon executable SECURITY DEFINER 0, project `ACTIVE_HEALTHY`

These 107 Advisor `authenticated_security_definer_function_executable` warnings are accepted. Each remaining function still has an authenticated caller, is a policy/view helper, is finance, or is body-auth that requires `auth.uid()`.

## Rank-1 — Edge or caller refactor before any revoke (9)

Authenticated `EXECUTE` stays until every caller is proven not to need it. No SQL-only revoke.

| Function | Blocker |
|---|---|
| `record_booking_delivery` | SECURITY DEFINER parents exist, but `driver-pending-offers` calls it with `userClient.rpc` |
| `validate_driver_offer` | `get-driver-offer-snapshot` uses `userClient`; `booking-received` diagnose path is `service_role` only |
| `get_trip_passenger_details` | `driver-trip-passenger-details` uses `userClient` |
| `get_trip_driver_details` | `customer-trip-driver-details` uses `userClient` |
| `get_my_last_trip_driver_details` | same Edge function, `userClient` |
| `accept_scheduled_ride` | Edge plus driver-app JWT |
| `decline_scheduled_ride` | Edge plus driver-app JWT |
| `admin_get_user_email` | `admin_riders` view path, not an Edge-only helper |
| `is_location_search_ssot_enabled` | admin search client plus guest/search path |

The first seven can move only after the live `userClient` call is switched to a proven `service_role` Edge client and no app `.rpc` remains. The last two are not Edge-only refactors.

## Mounted app and JWT workflows (66)

Do not revoke. Callers are authenticated app or admin sessions.

Driver (32): `ack_offer_delivery`, `cancel_driver_own_lost_property_report`, `claim_active_device`, `clear_driver_own_towards_destination`, `driver_heartbeat_ping`, `driver_rate_passenger`, `driver_request_go_offline`, `driver_request_go_online`, `finalize_driver_onboarding_registration`, `force_driver_offline`, `get_customer_live_for_driver`, `get_driver_active_trip_snapshot`, `get_driver_document_eligibility`, `get_driver_own_lost_property_report`, `get_driver_own_lost_property_summary_counts`, `get_driver_own_profile_contact`, `get_driver_own_towards_destination`, `get_driver_pending_ride_offers`, `get_driver_queued_trips`, `get_driver_standards`, `list_driver_own_demand_zones`, `list_driver_own_lost_property_eligible_trips`, `list_driver_own_lost_property_reports`, `list_driver_own_scheduled_jobs`, `list_driver_own_trip_history`, `set_driver_own_towards_destination`, `submit_driver_document`, `submit_driver_location_sample`, `sync_current_driver_document_approval`, `update_driver_location`, `upsert_driver_presence`, `verify_active_device`.

Admin (21): `active_super_admin_count`, `admin_assign_staff_role`, `admin_create_staff_member`, `admin_decide_customer_identity`, `admin_list_drivers`, `admin_list_pending_customer_signups`, `admin_live_chat_driver_identity`, `admin_remove_staff_member`, `admin_save_demand_zone_settings`, `admin_save_driver_special_offer`, `admin_set_role_action_permission`, `admin_set_role_page_permission`, `admin_set_staff_active`, `admin_unlock_customer_name_edit`, `admin_update_staff_member`, `admin_user_directory`, `find_or_create_customer`, `get_dispatch_metrics`, `get_driver_document_compliance`, `lost_property_admin_unread_count`, `sync_staff_user_role`.

Customer and hub (6): `find_nearby_drivers`, `get_customer_identity_verification_gate`, `get_customer_pending_trip_rating`, `get_trip_driver_live_location`, `passenger_map_nearby_drivers`, `upsert_customer_live_location`.

Corporate JWT (7): `approve_corporate_request`, `log_corporate_audit`, `reactivate_corporate_account`, `reject_corporate_request`, `suspend_corporate_account`, `suspend_corporate_request`, `update_corporate_account_profile`.

## Finance, payout, and wallet (15)

Skipped. Requires a separately approved finance phase.

`admin_driver_financial_summaries`, `admin_driver_wallet_eligibility_balances`, `admin_set_driver_payout_operational_pause`, `driver_wallet_eligibility_balances`, `generate_invoice_number`, `get_driver_own_wallet_earning_rows`, `get_driver_own_wallet_summary`, `get_driver_own_withdrawal`, `get_driver_own_withdrawals`, `is_commission_wallet_reserve_enabled`, `ops_retry_failed_payout_item`, `resolve_driver_tier_commission_percent`, `resolve_wave_commission_percent`, `return_failed_payout_to_wallet`, `trip_row_is_commission_wallet_driver_collected`.

## RLS helpers (15)

Skipped. Requires a separately approved RLS/body-auth phase. Adding body-auth while keeping authenticated `EXECUTE` does not clear lint 0029.

`can_corporate_user_view_driver`, `can_driver_edit_vehicle`, `can_passenger_view_driver`, `can_passenger_view_driver_document`, `can_passenger_view_vehicle`, `can_write_corporate`, `current_driver_profile_id`, `driver_can_view_trip_via_offer`, `has_corporate_access`, `has_role`, `is_admin`, `is_driver`, `is_super_admin`, `require_authenticated_driver_id`, `staff_has_company_funds_read_access`.

## Body-auth corporate functions (2)

Keep authenticated `EXECUTE`. Both require `auth.uid()` and `has_corporate_access`. `service_role` cannot satisfy that check.

`activate_paid_corporate_trip`, `discard_unpaid_corporate_trip`.

## Count

9 + 66 + 15 + 15 + 2 = 107.
