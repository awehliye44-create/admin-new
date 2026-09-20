/**
 * Accept-offer Edge stage clock + post-canonical waitUntil helper.
 * Observability + reliable off-path P2 work — never changes assignment SSOT.
 */

declare const EdgeRuntime:
  | { waitUntil?: (promise: Promise<unknown>) => void }
  | undefined;

export type AcceptOfferStageName =
  | "edge_receive"
  | "auth_start"
  | "auth_end"
  | "offer_lookup_start"
  | "offer_lookup_end"
  | "eligibility_validation_start"
  | "eligibility_validation_end"
  | "lock_idempotency_start"
  | "lock_idempotency_end"
  | "accept_rpc_start"
  | "accept_rpc_end"
  | "CANONICAL_ASSIGNMENT_CONFIRMED"
  | "scheduled_guard_start"
  | "scheduled_guard_end"
  | "post_assignment_trip_fetch_start"
  | "post_assignment_trip_fetch_end"
  | "post_assignment_driver_fetch_start"
  | "post_assignment_driver_fetch_end"
  | "booking_delivery_start"
  | "booking_delivery_end"
  | "notification_enqueue"
  | "response_build_start"
  | "response_build_end"
  | "edge_response";

export type AcceptOfferPerfClock = {
  mark: (name: AcceptOfferStageName) => void;
  /** Absolute ms from request start for each marked stage. */
  snapshot: () => Record<string, number>;
  /** Derived non-overlapping durations for ops_logs / response. */
  durations: () => Record<string, number | null>;
};

function span(
  stages: Record<string, number>,
  start: AcceptOfferStageName,
  end: AcceptOfferStageName,
): number | null {
  const a = stages[start];
  const b = stages[end];
  if (typeof a !== "number" || typeof b !== "number") return null;
  return Math.max(0, b - a);
}

/**
 * Build incremental durations without double-counting nested work.
 * Post-canonical blocking = everything from CANONICAL_ASSIGNMENT_CONFIRMED → edge_response.
 */
export function deriveAcceptOfferEdgeDurations(
  stages: Record<string, number>,
): Record<string, number | null> {
  const edge_auth_ms = span(stages, "auth_start", "auth_end");
  const edge_offer_lookup_ms = span(stages, "offer_lookup_start", "offer_lookup_end");
  const edge_validation_ms = span(
    stages,
    "eligibility_validation_start",
    "eligibility_validation_end",
  );
  const edge_lock_ms = span(stages, "lock_idempotency_start", "lock_idempotency_end");
  const edge_accept_rpc_ms = span(stages, "accept_rpc_start", "accept_rpc_end");
  const edge_canonical_assignment_ms =
    typeof stages.CANONICAL_ASSIGNMENT_CONFIRMED === "number" &&
      typeof stages.accept_rpc_start === "number"
      ? Math.max(0, stages.CANONICAL_ASSIGNMENT_CONFIRMED - stages.accept_rpc_start)
      : edge_accept_rpc_ms;
  const edge_post_trip_fetch_ms = span(
    stages,
    "post_assignment_trip_fetch_start",
    "post_assignment_trip_fetch_end",
  );
  const edge_post_driver_fetch_ms = span(
    stages,
    "post_assignment_driver_fetch_start",
    "post_assignment_driver_fetch_end",
  );
  const edge_booking_delivery_ms = span(
    stages,
    "booking_delivery_start",
    "booking_delivery_end",
  );
  const edge_response_build_ms = span(
    stages,
    "response_build_start",
    "response_build_end",
  );
  const edge_post_canonical_blocking_ms =
    typeof stages.CANONICAL_ASSIGNMENT_CONFIRMED === "number" &&
      typeof stages.edge_response === "number"
      ? Math.max(0, stages.edge_response - stages.CANONICAL_ASSIGNMENT_CONFIRMED)
      : null;
  const edge_total_ms =
    typeof stages.edge_response === "number"
      ? stages.edge_response
      : typeof stages.response_build_end === "number"
      ? stages.response_build_end
      : null;

  return {
    edge_auth_ms,
    edge_offer_lookup_ms,
    edge_validation_ms,
    edge_lock_ms,
    edge_accept_rpc_ms,
    edge_canonical_assignment_ms,
    edge_post_trip_fetch_ms,
    edge_post_driver_fetch_ms,
    edge_booking_delivery_ms,
    edge_response_build_ms,
    edge_post_canonical_blocking_ms,
    edge_total_ms,
  };
}

export function createAcceptOfferPerfClock(
  elapsed: () => number,
): AcceptOfferPerfClock {
  const stages: Record<string, number> = {};
  return {
    mark(name) {
      if (stages[name] != null) return;
      stages[name] = elapsed();
    },
    snapshot() {
      return { ...stages };
    },
    durations() {
      return deriveAcceptOfferEdgeDurations(stages);
    },
  };
}

/** Keep Edge isolate alive for P2 work after the Driver response is sent. */
export function scheduleAcceptOfferBackground(
  task: () => Promise<unknown>,
  label: string,
): void {
  const run = () =>
    task().catch((error) => {
      console.warn(`[accept-offer] background ${label} failed:`, {
        message: error instanceof Error ? error.message : String(error),
      });
    });

  if (typeof EdgeRuntime !== "undefined" && typeof EdgeRuntime.waitUntil === "function") {
    EdgeRuntime.waitUntil(run());
    return;
  }
  // Local / missing waitUntil — still fire-and-forget (must not block response).
  void run();
}

/**
 * Minimal authoritative trip seed for Driver activeTrip after canonical accept.
 * Built from accept_ride_offer RPC fields — never fabricates assignment.
 */
export function buildMinimalAcceptedTripSeed(input: {
  tripId: string;
  driverId: string;
  rpc: Record<string, unknown>;
}): Record<string, unknown> {
  const rpc = input.rpc;
  const status =
    typeof rpc.status === "string" && rpc.status.trim()
      ? rpc.status.trim()
      : "driver_assigned";
  return {
    id: input.tripId,
    status,
    driver_id: input.driverId,
    confirmed_driver_id: input.driverId,
    driver_net_pence: rpc.driver_net_pence ?? null,
    commission_pence: rpc.commission_pence ?? null,
    final_fare_pence: rpc.final_fare_pence ?? null,
    final_customer_fare_pence: rpc.final_customer_fare_pence ?? null,
    gross_fare_pence: rpc.gross_fare_pence ?? null,
    discount_pence: rpc.discount_pence ?? null,
    offered_driver_net_pence: rpc.offered_driver_net_pence ?? null,
    accepted_commission_percent: rpc.effective_commission_percent ?? null,
    accepted_dispatch_wave: rpc.dispatch_wave ?? null,
    accepted_dispatch_round: rpc.dispatch_round ?? null,
    accepted_ride_offer_id: rpc.offer_id ?? null,
    fare_source: rpc.fare_source ?? null,
  };
}
