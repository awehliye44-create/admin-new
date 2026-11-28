/** Offline test/audit-only helpers; not part of Edge uploads. */
import { PaymentSessionCaptureTripEvidence, PaymentSessionCaptureBreakdown, nullableComponentPence, buildPaymentSessionCaptureBreakdown } from "../../../functions/_shared/paymentSessionsCaptureBreakdownSSOT.ts";


/**
 * Payment Sessions–owned entry point for completed-trip capture explanation.
 * FR must call this or readPersistedCaptureBreakdown — never invent reasons locally.
 */
export function buildCaptureBreakdownForCompletedTrip(args: {
  trip: PaymentSessionCaptureTripEvidence;
  provider_captured_pence: number | null;
  canonical_expected_capture_pence?: number | null;
}): PaymentSessionCaptureBreakdown {
  const trip = args.trip;
  const ride = nullableComponentPence(
    trip.final_customer_fare_pence
      ?? trip.commissionable_fare_pence
      ?? trip.locked_base_fare_pence
      ?? trip.gross_fare_pence,
  );
  const pickup = nullableComponentPence(trip.pickup_waiting_charge_pence);
  const stop = nullableComponentPence(
    trip.stop_waiting_charge_pence ?? trip.stop_charge_total_pence,
  );
  const noShow = nullableComponentPence(trip.no_show_charge_pence);
  const airport = nullableComponentPence(trip.airport_charge_pence);
  const tip = nullableComponentPence(trip.tip_pence ?? trip.tip_amount_pence);
  const extras = nullableComponentPence(trip.extras_pence);
  let manual = nullableComponentPence(trip.customer_modification_charge_pence);
  let destination = nullableComponentPence(trip.destination_change_adjustment_pence);
  const other = nullableComponentPence(trip.other_pass_through_charges_pence);

  // final_customer_fare already includes destination/stop modification deltas.
  // Adding those fields again invents false expected capture (MK-260815-029).
  const rideFromFinalCustomer =
    nullableComponentPence(trip.final_customer_fare_pence) != null &&
    ride === nullableComponentPence(trip.final_customer_fare_pence);
  if (rideFromFinalCustomer && ((manual ?? 0) > 0 || (destination ?? 0) > 0)) {
    manual = null;
    destination = null;
  }

  const persistedFinal = nullableComponentPence(trip.final_fare_pence);
  const canonical = nullableComponentPence(args.canonical_expected_capture_pence)
    ?? persistedFinal;

  return buildPaymentSessionCaptureBreakdown({
    ride_fare_pence: ride,
    pickup_waiting_charge_pence: pickup,
    stop_waiting_charge_pence: stop,
    no_show_charge_pence: noShow,
    airport_charge_pence: airport,
    toll_charge_pence: null,
    parking_charge_pence: null,
    extra_stop_charge_pence: extras,
    manual_adjustment_pence: manual,
    destination_change_pence: destination,
    tip_pence: tip,
    other_payment_component_pence: other,
    canonical_expected_capture_pence: canonical,
    provider_captured_pence: args.provider_captured_pence,
  });
}

export * from "../../../functions/_shared/paymentSessionsCaptureBreakdownSSOT.ts";
