/**
 * stop-workflow caller and operational-cash gates.
 * Body driver_id is never an authorization source.
 * No proven internal service_role caller of stop-workflow exists.
 */

export const STOP_WORKFLOW_ACTIONS = [
  "start_journey_to_pickup",
  "arrive_pickup",
  "start_trip",
  "arrive_stop",
  "next_stop",
  "drive_to_next",
  "complete_trip",
  "driver_cancel",
  "cancel_queued_stacked",
] as const;

export type StopWorkflowAction = (typeof STOP_WORKFLOW_ACTIONS)[number];

export const OPERATIONAL_CASH_VIOLATION =
  "FINANCIAL_MODEL_VIOLATION: Cash trip completion is no longer supported. ONECAB is digital-only.";

export type StopWorkflowCallerDecision =
  | { ok: true; driverId: string; ignoredBodyDriverId: boolean }
  | { ok: false; code: "UNAUTHORIZED" | "FORBIDDEN"; status: 401 | 403; message: string };

export function decideStopWorkflowCaller(input: {
  hasAuthorizationHeader: boolean;
  userId: string | null;
  driverIdForUser: string | null;
  bodyDriverId?: string | null;
}): StopWorkflowCallerDecision {
  if (!input.hasAuthorizationHeader || !input.userId) {
    return {
      ok: false,
      code: "UNAUTHORIZED",
      status: 401,
      message: input.hasAuthorizationHeader
        ? "Invalid or expired token"
        : "Authentication required",
    };
  }
  if (!input.driverIdForUser) {
    return {
      ok: false,
      code: "FORBIDDEN",
      status: 403,
      message: "Driver account not found for authenticated user",
    };
  }
  return {
    ok: true,
    driverId: input.driverIdForUser,
    ignoredBodyDriverId: Boolean(
      input.bodyDriverId && input.bodyDriverId !== input.driverIdForUser,
    ),
  };
}

export function tripVisibleToDriver(input: {
  tripExists: boolean;
  assignedDriverId: string | null;
  callerDriverId: string;
  hasPendingOrAcceptedOffer: boolean;
}): { visible: true; claimViaOffer: boolean } | { visible: false } {
  if (!input.tripExists) return { visible: false };
  if (input.assignedDriverId === input.callerDriverId) {
    return { visible: true, claimViaOffer: false };
  }
  if (input.hasPendingOrAcceptedOffer) {
    return { visible: true, claimViaOffer: true };
  }
  return { visible: false };
}

export function isDriverCollectedCashTrip(trip: {
  financial_model?: string | null;
  payment_method?: string | null;
  payment_status?: string | null;
}): boolean {
  return String(trip.financial_model ?? "").trim().toUpperCase()
      === "DRIVER_COLLECTED_COMMISSION_WALLET"
    && String(trip.payment_method ?? "").trim().toLowerCase() === "cash";
}

export function isPlatformCollectedOperationalCash(trip: {
  financial_model?: string | null;
  payment_method?: string | null;
  cash_authorized_at?: string | null;
}): boolean {
  const model = String(trip.financial_model ?? "").trim().toUpperCase();
  const method = String(trip.payment_method ?? "").trim().toLowerCase();
  return model === "PLATFORM_COLLECTED" && method === "cash";
}

export function completeTripCashDecision(trip: {
  financial_model?: string | null;
  payment_method?: string | null;
  payment_status?: string | null;
  cash_authorized_at?: string | null;
}): "allow_driver_collected" | "fail_closed_operational_cash" | "not_cash" {
  if (isDriverCollectedCashTrip(trip)) return "allow_driver_collected";
  if (isPlatformCollectedOperationalCash(trip)) return "fail_closed_operational_cash";
  return "not_cash";
}
