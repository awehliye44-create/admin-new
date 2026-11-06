/**
 * MK-261106-004 — scheduled / pre-completion fare capture gate.
 *
 * Fare capture may call the payment provider only after trips.status === "completed".
 * Terminal cancel/no-show fee partial captures use captureKind "terminal_fee".
 * Never capture early to keep a booking alive when a hold is expiring.
 *
 * Incident (read-only audit): MK-261106-004 (£6.11) was AUTHORISED only —
 * not captured. This gate closes provider-call bypass classes.
 */

export type FareCaptureKind = "fare" | "terminal_fee";

export type FareCaptureGateResult =
  | { ok: true }
  | { ok: false; code: string; error: string };

/** Live / pre-completion statuses that must never fare-capture. */
export const FARE_CAPTURE_BLOCKED_TRIP_STATUSES = new Set([
  "scheduled",
  "pending",
  "payment_pending",
  "searching",
  "searching_new_driver",
  "offered",
  "offering",
  "broadcasting",
  "negotiating",
  "queued",
  "scheduled_committed",
  "accepted",
  "confirmed",
  "driver_assigned",
  "assigned",
  "en_route",
  "en_route_to_pickup",
  "enroute_to_pickup",
  "driver_en_route",
  "driver_arriving",
  "arrived",
  "arrived_pickup",
  "arrived_at_pickup",
  "at_pickup",
  "pickup_waiting",
  "waiting",
  "waiting_at_pickup",
  "in_progress",
  "started",
  "on_trip",
  "ongoing",
  "trip_started",
  "completing",
  "arrived_at_stop",
  "drive_to_next_stop",
  "admin_held",
]);

/** Terminal statuses where cancel/no-show fee partial capture is allowed. */
export const TERMINAL_FEE_CAPTURE_TRIP_STATUSES = new Set([
  "cancelled",
  "canceled",
  "customer_cancelled",
  "driver_cancelled",
  "no_show",
  "expired",
  "expired_no_driver",
  "failed",
  "discarded",
]);

export function normalizeTripStatusForCaptureGate(status: unknown): string {
  return String(status ?? "").trim().toLowerCase();
}

export function isTripCompletedForFareCapture(status: unknown): boolean {
  return normalizeTripStatusForCaptureGate(status) === "completed";
}

export function isTerminalFeeCaptureTripStatus(status: unknown): boolean {
  return TERMINAL_FEE_CAPTURE_TRIP_STATUSES.has(normalizeTripStatusForCaptureGate(status));
}

/**
 * True when a provider COMPLETED/CAPTURED webhook may advance local capture
 * evidence for a RIDE_BOOKING session. Fare completion or terminal fee only.
 */
export function shouldMirrorRideBookingProviderCapture(args: {
  tripStatus: unknown;
  purpose?: string | null;
}): boolean {
  const purpose = String(args.purpose ?? "").trim().toUpperCase();
  if (purpose && purpose !== "RIDE_BOOKING" && !purpose.includes("RECOVERY")) {
    // Non-booking purposes (recovery child sessions handled separately).
    return true;
  }
  if (purpose.includes("RECOVERY")) return true;
  if (isTripCompletedForFareCapture(args.tripStatus)) return true;
  if (isTerminalFeeCaptureTripStatus(args.tripStatus)) return true;
  return false;
}

/**
 * Gate at the point that calls the payment provider capture API.
 */
export function assertFareCaptureAllowedAtProvider(args: {
  tripStatus: unknown;
  captureKind: FareCaptureKind;
}): FareCaptureGateResult {
  const status = normalizeTripStatusForCaptureGate(args.tripStatus);

  if (args.captureKind === "terminal_fee") {
    if (isTerminalFeeCaptureTripStatus(status)) return { ok: true };
    return {
      ok: false,
      code: "TERMINAL_FEE_CAPTURE_NOT_ALLOWED",
      error: `Terminal fee capture refused for trip status "${status || "unknown"}"`,
    };
  }

  // Fare capture — completed only. Never capture early to keep a booking alive.
  if (status === "completed") return { ok: true };

  return {
    ok: false,
    code: "FARE_CAPTURE_BEFORE_COMPLETION",
    error: "Cannot capture Revolut hold before trip is completed",
  };
}
