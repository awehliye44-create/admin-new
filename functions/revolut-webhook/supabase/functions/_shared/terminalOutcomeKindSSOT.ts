/**
 * Chargeable terminal outcome kind + entitled driver (pure — no I/O).
 *
 * Settlement, wallet eligibility (TS) and driver_wallet_eligibility_balances
 * (SQL: trip_chargeable_terminal_outcome_kind / trip_terminal_entitled_driver_id)
 * must agree. Parity lock: terminalWalletEligibilityParity.lock.test.ts.
 */

export type TerminalOutcomeKind =
  | "NO_SHOW"
  | "LATE_PASSENGER_CANCELLATION"
  | "ARRIVAL_CANCELLATION";

export type TerminalOutcomeKindInput = {
  financial_outcome?: string | null;
  status?: string | null;
  payment_status?: string | null;
  no_show_charge_pence?: number | null;
};

export const CHARGEABLE_TERMINAL_OUTCOMES = new Set<TerminalOutcomeKind>([
  "NO_SHOW",
  "LATE_PASSENGER_CANCELLATION",
  "ARRIVAL_CANCELLATION",
]);

function pence(v: unknown): number {
  const n = Math.round(Number(v ?? 0));
  return Number.isFinite(n) ? n : 0;
}

/**
 * CANCELLED_WITH_FEE is not a terminal kind and must not become
 * Late Passenger Cancellation or Arrival Cancellation.
 * Arrival stamps alone do not settle historical rows.
 */
export function resolveTerminalOutcomeKind(trip: TerminalOutcomeKindInput): TerminalOutcomeKind | null {
  const outcome = String(trip.financial_outcome ?? "").toUpperCase();
  const status = String(trip.status ?? "").toLowerCase();
  const paymentStatus = String(trip.payment_status ?? "").toLowerCase();
  const noShowCharge = pence(trip.no_show_charge_pence);

  if (
    outcome === "COMPLETED"
    || outcome === "CANCELLED_NO_FEE"
    || outcome === "CANCELLED_WITH_FEE"
  ) {
    return null;
  }

  if (outcome === "ARRIVAL_CANCELLATION") return "ARRIVAL_CANCELLATION";
  if (outcome === "NO_SHOW" || status === "no_show") return "NO_SHOW";
  if (outcome === "LATE_PASSENGER_CANCELLATION") return "LATE_PASSENGER_CANCELLATION";

  if (paymentStatus === "fee_pending_settlement" && (noShowCharge > 0 || status === "no_show")) {
    return "NO_SHOW";
  }

  if (paymentStatus.includes("no_show") && noShowCharge > 0) return "NO_SHOW";

  return null;
}

/**
 * Driver who qualified for the terminal fee.
 * Active assignment wins while it still exists. After the cancel trigger
 * nulls driver_id / confirmed_driver_id, previous_driver_id is the preserved
 * entitled driver. Never read a nulled driver_id as "no driver".
 */
export function resolveTerminalEntitledDriverId(trip: {
  driver_id?: string | null;
  confirmed_driver_id?: string | null;
  previous_driver_id?: string | null;
}): string | null {
  const active = String(trip.confirmed_driver_id ?? "").trim()
    || String(trip.driver_id ?? "").trim();
  if (active) return active;
  const preserved = String(trip.previous_driver_id ?? "").trim();
  return preserved || null;
}
