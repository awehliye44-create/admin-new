/**
 * Classify Revolut order states for booking payment idempotency.
 *
 * - unresolved → reuse / reconcile (never create a second order)
 * - terminal_block → cancelled / failed — must not continue booking on this draft
 * - authorised → proceed only after amount/currency match
 */

export type RevolutBookingAttemptDecision =
  | "reuse_unresolved"
  | "reuse_authorised"
  | "terminal_block"
  | "allow_new_order";

const UNRESOLVED = new Set([
  "PENDING",
  "PROCESSING",
  "AUTHENTICATION_CHALLENGE",
]);

const AUTHORISED = new Set(["AUTHORISED"]);

const TERMINAL_BLOCK = new Set([
  "CANCELLED",
  "CANCELED",
  "FAILED",
  "DECLINED",
  "REFUNDED",
]);

export function normaliseRevolutOrderState(state: string | null | undefined): string {
  return String(state ?? "").trim().toUpperCase();
}

/**
 * Decide whether a booking draft may create a new Revolut order given an
 * existing order for the same client_action_id / idempotency key.
 */
export function classifyRevolutOrderForBookingRetry(
  state: string | null | undefined,
): RevolutBookingAttemptDecision {
  const s = normaliseRevolutOrderState(state);
  if (!s) return "allow_new_order";
  if (UNRESOLVED.has(s)) return "reuse_unresolved";
  if (AUTHORISED.has(s)) return "reuse_authorised";
  if (TERMINAL_BLOCK.has(s)) return "terminal_block";
  // COMPLETED / unknown — do not silently create a second booking hold.
  if (s === "COMPLETED") return "terminal_block";
  return "reuse_unresolved";
}

export function isRevolutBookingTerminalBlockState(
  state: string | null | undefined,
): boolean {
  return classifyRevolutOrderForBookingRetry(state) === "terminal_block";
}

export function isRevolutBookingUnresolvedState(
  state: string | null | undefined,
): boolean {
  return classifyRevolutOrderForBookingRetry(state) === "reuse_unresolved";
}

/** Exact amount + currency match before treating an authorised hold as booking-ready. */
export function authorisedHoldMatchesBooking(args: {
  orderAmountMinor: number | null | undefined;
  orderCurrency: string | null | undefined;
  expectedAmountMinor: number;
  expectedCurrency: string;
}): boolean {
  const amount = Math.round(Number(args.orderAmountMinor) || 0);
  const expected = Math.round(Number(args.expectedAmountMinor) || 0);
  if (amount <= 0 || expected <= 0 || amount !== expected) return false;
  const cur = String(args.orderCurrency ?? "").trim().toUpperCase();
  const exp = String(args.expectedCurrency ?? "").trim().toUpperCase();
  return Boolean(cur) && Boolean(exp) && cur === exp;
}
