/**
 * Single timeout owner for preset negotiation: expire-offers.
 * Local app clocks display remaining time only.
 * Customer/Driver sync may read/reconcile; they must not rematch or stamp
 * second chance / £Z failure.
 */

export const NEGOTIATION_TIMEOUT_OWNER = "expire-offers" as const;

export const LIVE_NEGOTIATION_TIMEOUT_PHASES = [
  "waiting_customer",
  "waiting_driver_final",
  "declined_customer_awaiting_driver",
] as const;

export type LiveNegotiationTimeoutPhase =
  (typeof LIVE_NEGOTIATION_TIMEOUT_PHASES)[number];

export function isLiveNegotiationTimeoutPhase(
  status: string | null | undefined,
): status is LiveNegotiationTimeoutPhase {
  return (LIVE_NEGOTIATION_TIMEOUT_PHASES as readonly string[]).includes(
    status ?? "",
  );
}

/**
 * Customer £Y ignore / timeout / stuck waiting_customer → second chance.
 * Never rematch / exclude from this phase.
 */
export function waitingCustomerExpiryAction(input: {
  negotiationStatus: string | null | undefined;
  driverId: string | null | undefined;
}): "second_chance" | "skip" {
  if (input.negotiationStatus !== "waiting_customer") return "skip";
  if (!input.driverId) return "skip";
  return "second_chance";
}

/** Work-gate: live negotiation deadlines must invoke expire-offers even when countered + paused. */
export function expireOffersSweepSeesLiveNegotiation(row: {
  offerStatus: string;
  tripStatus?: string | null;
  dispatchStatus?: string | null;
  negotiationStatus: string | null | undefined;
  customerRespondByIso?: string | null;
  driverRespondByIso?: string | null;
  graceWindowExpiresAtIso?: string | null;
  nowIso: string;
}): boolean {
  if (row.offerStatus !== "pending" && row.offerStatus !== "countered") {
    return false;
  }
  const ns = row.negotiationStatus ?? "";
  if (ns === "waiting_customer") {
    return Boolean(
      row.customerRespondByIso && row.customerRespondByIso <= row.nowIso,
    );
  }
  if (ns === "waiting_driver_final" || ns === "waiting_driver") {
    return Boolean(
      row.driverRespondByIso && row.driverRespondByIso <= row.nowIso,
    );
  }
  if (ns === "declined_customer_awaiting_driver") {
    return Boolean(
      row.graceWindowExpiresAtIso && row.graceWindowExpiresAtIso <= row.nowIso,
    );
  }
  return false;
}

export function clientLocalCountdownMayMutateNegotiation(): false {
  return false;
}
