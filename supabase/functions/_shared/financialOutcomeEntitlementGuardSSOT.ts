/**
 * Pre-posting guard for record-financial-outcome.
 *
 * A chargeable terminal outcome (NO_SHOW / ARRIVAL_CANCELLATION /
 * LATE_PASSENGER_CANCELLATION) may only be recorded on a trip that did not
 * complete, for the driver who was actually assigned, and without replacing a
 * different outcome already stamped on the trip.
 */

export type FinancialOutcomeGuardTrip = {
  status?: string | null;
  completed_at?: string | null;
  driver_id?: string | null;
  confirmed_driver_id?: string | null;
  previous_driver_id?: string | null;
  arrived_at?: string | null;
  financial_outcome?: string | null;
};

export type FinancialOutcomeGuardResult =
  | { ok: true; entitledDriverId: string }
  | {
    ok: false;
    status: 409 | 403;
    code:
      | "COMPLETED_TRIP_NOT_ELIGIBLE"
      | "NO_ENTITLED_DRIVER"
      | "DRIVER_NOT_ENTITLED"
      | "DRIVER_NEVER_ARRIVED"
      | "OUTCOME_CONFLICT";
  };

const ARRIVAL_REQUIRED_OUTCOMES = new Set(["NO_SHOW", "ARRIVAL_CANCELLATION"]);

export function resolveEntitledTerminalDriverId(trip: FinancialOutcomeGuardTrip): string | null {
  return trip.previous_driver_id ?? trip.confirmed_driver_id ?? trip.driver_id ?? null;
}

export function evaluateFinancialOutcomeEntitlement(args: {
  trip: FinancialOutcomeGuardTrip;
  requestedDriverId: string;
  outcome: string;
}): FinancialOutcomeGuardResult {
  const { trip } = args;
  if (String(trip.status ?? "").toLowerCase() === "completed" || trip.completed_at) {
    return { ok: false, status: 409, code: "COMPLETED_TRIP_NOT_ELIGIBLE" };
  }
  const entitled = resolveEntitledTerminalDriverId(trip);
  if (!entitled) return { ok: false, status: 409, code: "NO_ENTITLED_DRIVER" };
  if (entitled !== args.requestedDriverId) return { ok: false, status: 403, code: "DRIVER_NOT_ENTITLED" };
  if (ARRIVAL_REQUIRED_OUTCOMES.has(args.outcome) && !trip.arrived_at) {
    return { ok: false, status: 409, code: "DRIVER_NEVER_ARRIVED" };
  }
  const stamped = trip.financial_outcome ?? null;
  if (stamped && stamped !== args.outcome) return { ok: false, status: 409, code: "OUTCOME_CONFLICT" };
  return { ok: true, entitledDriverId: entitled };
}
