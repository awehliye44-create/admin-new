# #116 — MK-261126-009 dispatch / notification / rematch RCA

**Severity:** Critical blocker for #110 programme closure  
**Trip:** MK-261126-009 (`3a8353b7-39f8-4334-9254-5626c477212e`)  
**Stage D:** true/true (unchanged) · Atomic completion: STOP

## Confirmed root causes

1. **Negotiation rematch broadcast reopen blocked (primary)**  
   `trips_enforce_airport_broadcast_hold` refused every `broadcast_enabled` false→true unless `onecab.release_airport_broadcast_hold='1'`. After Faster preset → customer decline, `finalize_negotiation_failure` set `searching_new_driver` + `broadcast_enabled=true`, but the trigger kept `broadcast_enabled=false` (`scheduled_hold_reason` was NULL, `dispatch_mode=instant`). Rematch aborted `LOCKED_DRIVER_TRIP` at 18:57:11Z. Trip later cancelled; hold released.

2. **Wave-1 empty then wave-2 offer (expected policy, not a bug)**  
   Only idle eligible at wave-2: MK0012 at ~8.7 km (wave-1 5 km radius correctly excluded `out_of_radius`). Nearby MK0007 (passenger’s own driver account) was `busy_on_trip` / stack-ineligible on MK-261126-006.

3. **False `driver_net_not_ready` push skip (telemetry)**  
   `createdOffers` mapped only `{id, driver_id}` so auto-dispatch push loop saw no snapshot/net → `push_sent_count=0`. Real APNs still sent via insert → `send-driver-notification` (“New ride offer available near you!”).

4. **Customer negotiation banner on Driver Home (not token cross-routing)**  
   Copy is Customer-only. Offer was to MK0012; passenger Ahmed also has driver MK0007 + Customer app. Banner is Customer local/push shown by iOS over whichever app is foreground. #57F/G token tables remain separated; no customer copy path into Driver process.

5. **Offer card**  
   `offer_snapshot.selectedOffer=Faster £5.90` proves MK0012 card rendered and driver interacted. “Finding trips” after decline / on a non-offered device is expected. Launched OTA `01a2178e…` / `1.0.6(4)` — not P7A; no #110/P7A hydration regression found.

## Timeline (UTC)

| Time | Event |
|------|--------|
| 18:53:35 | Payment session authorised (700p hold, Revolut) |
| 18:53:40 | Trip created / wave-1 eligibility (`trip_insert`); MK0012 out_of_radius ~8.6 km |
| 18:54:32 | `stale_trip_no_pending` rebroadcast entries |
| 18:54:58 | Wave-2 offer `6f3b94b1…` → MK0012; push enqueue |
| 18:54:59 | auto-dispatch `push_skipped` `driver_net_not_ready` (false); `push_sent_count=0` |
| 18:55:01 | Offer ack / delivered (realtime first_write) |
| 18:55:06 | Driver APNs `NEW_RIDE_OFFER` sent OK |
| 18:55:12 | `booking_received_via=poll` stamped on delivery_trace |
| ~18:55+ | Driver selected Faster £5.90 → customer negotiation copy |
| 18:56:19 | Reminder-2 cancelled (`offer_status_is_countered`) |
| 18:56:29 | Offer declined (`declined_negotiation` / `declined_driver`) |
| 18:57:10 | `negotiation_failure_rematch` |
| 18:57:11 | `dispatch_aborted` **LOCKED_DRIVER_TRIP** (`broadcast_enabled` still false) |
| 18:58:42 | Trip cancelled |
| 18:58:47 | Payment session released (700p) — no capture, no fee, no earnings |

## Financial safety

- Session `released`, `captured_amount_pence=0`, `released_amount_pence=700`  
- No stranded authorisation, duplicate payment, cancellation fee, or driver earning  
- Do not manually mutate; do not create another paid booking for verification

## Permanent correction

- Migration `20270304120000_bug116_negotiation_rematch_broadcast_reopen.sql` — allow reopen when `scheduled_hold_reason` IS NULL; keep airport / active-hold refuse  
- auto-dispatch + `driverNetPenceFromOfferContext` — carry offered net into push loop  
- Lock tests: `bug116NegotiationRematchBroadcastHold.lock.test.ts` (+ scheduled hold SSOT assert)  
- Parity SQL bodies updated

## Performance (this trip)

| Segment | Latency |
|---------|---------|
| Booking create → first eligibility | ~0s (same second) |
| Create → first offer (wave-2) | ~78s (wave-1 empty by radius) |
| Offer create → realtime ack | ~3.5s |
| Offer create → APNs push_sent | ~8s |
| Offer → actionable card | ≤~14s (poll receive 18:55:12; selectedOffer proves UI) |

## Platforms

- Customer iOS (booking channel: app)  
- Driver iOS MK0012 (offered) / MK0007 (passenger dual-role, busy — not offered)

## Remaining physical verification

1. Deploy migration + auto-dispatch  
2. Organic unpaid/non-money path or staff-observed rematch after negotiation decline: `broadcast_enabled` must become true and next wave must run  
3. Confirm Driver push audit `push_sent_count ≥ 1` when net known  
4. #110 closure still requires organic/device acceptance after #116 clear
