/** Offline test/audit-only helpers; not part of Edge uploads. */
import { DispatchTripRequest, SchemaField, CompleteTripRequest } from "../../../functions/_shared/validation.ts";


export const dispatchTripSchema: Record<keyof DispatchTripRequest, SchemaField> = {
  trip_id: { type: 'uuid' },
  pickup_lat: { type: 'latitude' },
  pickup_lng: { type: 'longitude' },
  vehicle_type_id: { type: 'uuid', optional: true },
  max_distance_km: { type: 'number', optional: true, min: 1, max: 100 },
  max_drivers: { type: 'number', optional: true, min: 1, max: 50, integer: true },
  offer_timeout_seconds: { type: 'number', optional: true, min: 10, max: 300, integer: true },
};


export const completeTripSchema: Record<keyof CompleteTripRequest, SchemaField> = {
  trip_id: { type: 'uuid' },
  driver_id: { type: 'uuid' },
  payment_method: { type: 'payment_method' },
  base_fare_pence: { type: 'number', min: 0, max: 100000000, integer: true },
  pickup_waiting_charge_pence: { type: 'number', min: 0, max: 10000000, integer: true, optional: true },
  stop_waiting_charge_pence: { type: 'number', min: 0, max: 10000000, integer: true, optional: true },
  stop_modification_charge_pence: { type: 'number', min: 0, max: 10000000, integer: true, optional: true },
  destination_change_charge_pence: { type: 'number', min: 0, max: 10000000, integer: true, optional: true },
  extras_charge_pence: { type: 'number', min: 0, max: 10000000, integer: true, optional: true },
  tip_amount_pence: { type: 'number', min: 0, max: 10000000, integer: true, optional: true },
  provider_payment_id: { type: 'string', optional: true, maxLength: 255 },
  final_fare_pence: { type: 'number', min: 0, max: 100000000, integer: true, optional: true },
};

export * from "../../../functions/_shared/validation.ts";
