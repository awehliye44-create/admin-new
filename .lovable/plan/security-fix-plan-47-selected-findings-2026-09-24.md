# Security fix plan — 47 selected findings

These fixes touch live money flows (ride pricing, driver wallet top-ups) and the customer/driver apps' map search. The plan groups them by risk so you can approve before anything changes.

## Group A — Internal jobs anyone can trigger (low risk)
Require the scheduler/service key (existing `assertCronOrServiceRoleAuth` helper) before running:
- scheduled-dispatch, schedule-dispatch, ride-offer-reminders, expire-offers (2 findings), ack-timeout-sweep, expire-stale-drivers, financial-ssot-monitor
- diag: delete the function entirely (debug endpoint returning trips/drivers).
- WhatsApp expiry job: verify the service-role key by exact match instead of decoding an unverified token.

## Group B — Paid services and messages anyone can use (medium risk)
Require a signed-in user (`auth.getUser`) for:
- postcode-lookup, mapbox-places, place-lookup, driving-directions (Mapbox), improve-lost-item-description (AI)
- customer push notification endpoint: admin/service only
- send-document-notification: admin only, HTML-escape document name and reason
- send-email: admin/service only, escape or reject caller HTML
- merchant-signup: add sign-in / input validation per finding

Risk: if the customer app searches addresses before sign-in, those searches would stop working for signed-out guests (e.g. QR guest bookings).

## Group C — Money and ownership (high risk)
- create-preauth-payment-intent (3 findings): recompute the fare server-side from `service_area_vehicle_pricing` via the existing fare engine; ignore `estimated_fare` / `hold_pence` from the app.
- driver-commission-wallet-initiate-topup (2 findings): stop auto-crediting sandbox top-ups; credit only after a confirmed Revolut payment (webhook/verify).
- create-trip-after-payment: only update trip notes when the trip belongs to the caller.
- lost-property-transition: allow only jpeg/png/webp, max 5 MB, safe server-generated filenames.
- call-masking logs: mask phone numbers (last 3 digits only).

## Group D — Database access rules
- Settings/config tables (regions, service_areas, service_area_payment_methods, stop_waiting_settings, service_area_sequences, service_area_customer_identity_settings, offer_service_areas, preset_offers, marketplace/merchant settings, merchant categories, location_search_rollout, ai_credit packages/settings, app_performance_baselines): replace "everyone" rules with staff-only reads, plus signed-in reads limited to active rows where the apps need them. `service_area_sequences` and `app_performance_baselines` become staff-only.
- Driver statement PDFs: drivers read only files in their own folder; admins read all.
- Merchant assets: remove the listing rule; public download links keep working.

## Technical notes
- Edge function changes only take effect after the functions are deployed; this project's backend can't be checked live from here.
- Findings are marked fixed after the code/migration changes are made.
