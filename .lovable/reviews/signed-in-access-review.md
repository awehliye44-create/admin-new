# Review: database steps signed-in users can run (163)

Date: 2026-11-19. Read every SECURITY DEFINER function in `public` that `authenticated` can EXECUTE.

## Fixed (migration, verified with a rolled-back test as a real rider/driver/admin)
- `upsert_driver_presence` (and `driver_heartbeat_ping`, which calls it): admin bypass checked legacy `profiles.role = 'admin'`; now `has_role(auth.uid(), 'admin')` (user_roles SOT). Rider on another driver -> NOT_AUTHORIZED; driver self and admin still allowed.
- `record_driver_location_publish_diag` (origin `customer_client`): matched `trips.passenger_id = auth.uid()` (customer id vs auth user id), so rider rows were always rejected; now joins `customers.user_id`. Rider may only attribute the row to that trip's driver; any other claimed driver id goes to `metadata.claimed_driver_id`.
- `can_corporate_user_view_driver(p_driver_id, p_user_id)`: any signed-in user could ask about any other user; now only about themselves. No callers found in app, edge functions, policies or views.

## Checked, no change needed
- 61 staff/admin steps: each blocks at the start via `has_role(...,'admin')`, `staff_has_page_access`, `staff_has_action`, `admin_assert_staff_page`, `assert_finance_payout_ledger_access`, `is_super_admin`, or corporate membership; `reject_roles_action` raises.
- 72 driver/rider self-service steps: identity comes from `auth.uid()` / `current_driver_id()`; any id parameter is compared to the caller (e.g. `accept_scheduled_ride`, `submit_driver_location_sample`, `validate_driver_offer`, `update_driver_location`, `get_trip_driver_live_location`).
- 30 helpers: settings readers (`resolve_*_commission_percent`, `is_location_search_ssot_enabled`, `is_active_service_area`), RLS helpers (`has_role`, `is_super_admin`, `staff_has_page_access`), and pure functions.

## Left as is (low risk, by design or needs your decision)
- `is_owner`, `is_driver`, `staff_role_id_of`, `staff_has_action` accept any user id and answer yes/no. Used inside policies, views and other steps with other users' ids, so they cannot be limited to the caller without breaking them. A user id must already be known.
- `admin_driver_wallet_eligibility_balances`, `get_driver_document_compliance`, `active_super_admin_count`: any active staff member passes, regardless of page permissions. Belongs to Stage 2 permissions work (waiting on your review).
- `dismiss_driver_tip_thanks`, `list_pending_driver_tip_thanks`: extra `passenger_id = auth.uid()` branch is dead but harmless.
