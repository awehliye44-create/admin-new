# Test Day Reset — Pre-Reset Backup

Captured: 2026-06-01 (UTC)

## Row counts (pre-reset)

| Table | Rows |
|---|---:|
| trips | 1,446 |
| trip_stops | 3,132 |
| trip_stop_waiting | 0 |
| trip_change_requests | 20 |
| trip_messages | 45 |
| trip_driver_exclusions | 40 |
| trip_route_cache | 0 |
| trip_finance (deprecated) | 1 |
| ride_offers | 2,005 |
| dispatch_audit_log | 6,717 |
| dispatch_candidates_log | 0 |
| dispatch_eligibility_log | 5,988 |
| dispatch_round_advance_log | 361 |
| dispatch_wave_snapshot | 1,837 |
| dispatch_wave_snapshots | 328 |
| booking_delivery_log | 17,379 |
| driver_ledger (deprecated) | 0 |
| driver_wallet_ledger | 600 |
| driver_statements | 0 |
| payout_items | 5 |
| payout_batches | 0 |
| scheduled_offer_attempts | 3 |
| statement_runs | 4 |
| customer_wallet_ledger | 0 |
| offer_redemptions | 0 |

## Mapping to requested categories

- **Trip history**: trips, trip_stops, trip_stop_waiting, trip_change_requests, trip_messages, trip_driver_exclusions, trip_finance, trip_route_cache
- **Lifecycle / dispatch logs**: ride_offers, dispatch_audit_log, dispatch_eligibility_log, dispatch_round_advance_log, dispatch_wave_snapshot, dispatch_wave_snapshots, booking_delivery_log, scheduled_offer_attempts
- **Revenue / earnings**: driver_wallet_ledger, driver_ledger, driver_statements, payout_items, payout_batches, statement_runs, customer_wallet_ledger

## Retained (not touched)

- drivers, customers, vehicles, vehicle_types, service_areas, regions
- All settings (dispatch_settings, global_dispatch_settings, stop_waiting_settings, qr_booking_config, statement_schedule_configs, preset_offers, preset_offer_configs, offers, offer_service_areas)
- Stripe configuration, payment configuration, edge functions, cron jobs
- driver_wallets (running balances will be recomputed to 0 from ledger triggers; see report)
