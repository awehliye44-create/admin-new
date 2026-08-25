/** Pure hold-release helpers — no provider I/O. */

export const FORCE_SESSION_RELEASE_REASONS = new Set([
  "create_trip_failed_to_start",
  "booking_failed_no_trip",
  "edge_boot_failure",
  "customer_cancelled_authorised_hold",
]);

/** Trip-less AUTHORISED holds older than this are swept (Try Again window). */
export const TRIPLESS_AUTHORISED_HOLD_SWEEP_MIN_AGE_MS = 3 * 60 * 1000;

/** Local provider_state values that still look like an open hold. */
export const NONTERMINAL_LOCAL_PROVIDER_STATES = new Set([
  "AUTHORISED",
  "AUTHORIZED",
  "PAYMENT_AUTHENTICATED",
  "PENDING",
  "PROCESSING",
]);

export const PROVIDER_HOLD_CANCELABLE_STATES = new Set([
  "AUTHORISED",
  "AUTHORIZED",
  "PROCESSING",
  "PENDING",
]);

export const PROVIDER_HOLD_ALREADY_RELEASED_STATES = new Set([
  "CANCELLED",
  "CANCELED",
  "FAILED",
]);

export const PROVIDER_HOLD_CAPTURED_STATES = new Set([
  "COMPLETED",
  "CAPTURED",
]);

export type LocalHoldTerminalKind = "none" | "released" | "captured";

export type ProviderHoldDecision =
  | "RETRIEVE_REQUIRED"
  | "RECONCILE_LOCAL_ONLY"
  | "RELEASE_ONCE"
  | "NEVER_RELEASE_CAPTURED"
  | "NEVER_RELEASE_REFUNDED"
  | "IDEMPOTENT_ALREADY_RELEASED"
  | "RETRYABLE_PROVIDER_FAILURE";

export function shouldForceAuthorisedSessionRelease(reason: string): boolean {
  return FORCE_SESSION_RELEASE_REASONS.has(String(reason ?? "").trim());
}

export function sessionAgeMs(session: Record<string, unknown> | null | undefined): number {
  if (!session) return Number.POSITIVE_INFINITY;
  const raw = session.authorised_at ?? session.created_at;
  const t = Date.parse(String(raw ?? ""));
  return Number.isFinite(t) ? Math.max(0, Date.now() - t) : Number.POSITIVE_INFINITY;
}

export function classifyLocalHoldTerminal(
  session: Record<string, unknown> | null | undefined,
): LocalHoldTerminalKind {
  if (!session) return "none";
  if (session.captured_at || Number(session.captured_amount_pence ?? 0) > 0) return "captured";
  const hold = String(session.hold_release_state ?? "").toLowerCase();
  if (session.released_at || hold === "released") return "released";
  if (hold === "captured") return "captured";
  return "none";
}

/**
 * Local `released` / released_at is not authoritative while provider_state still
 * looks open — retrieve before skipping, or a false local release will stick.
 */
export function localReleasedNeedsProviderReconcile(
  session: Record<string, unknown> | null | undefined,
): boolean {
  if (classifyLocalHoldTerminal(session) !== "released") return false;
  const state = String(session?.provider_state ?? "").toUpperCase();
  return NONTERMINAL_LOCAL_PROVIDER_STATES.has(state);
}

/**
 * Decide action from a Merchant GET order snapshot (no mutation).
 * Captured / refunded orders must never take the hold-cancel path.
 */
export function classifyProviderHoldDecision(args: {
  providerState: string | null | undefined;
  completedAmountPence?: number | null;
  refundedAmountPence?: number | null;
  localTerminal?: LocalHoldTerminalKind;
}): ProviderHoldDecision {
  const state = String(args.providerState ?? "").toUpperCase();
  const completed = Math.max(0, Number(args.completedAmountPence ?? 0));
  const refunded = Math.max(0, Number(args.refundedAmountPence ?? 0));

  if (refunded > 0 || state === "REFUNDED") return "NEVER_RELEASE_REFUNDED";
  if (completed > 0 || PROVIDER_HOLD_CAPTURED_STATES.has(state)) {
    return "NEVER_RELEASE_CAPTURED";
  }
  if (PROVIDER_HOLD_ALREADY_RELEASED_STATES.has(state)) {
    return args.localTerminal === "released"
      ? "RECONCILE_LOCAL_ONLY"
      : "IDEMPOTENT_ALREADY_RELEASED";
  }
  if (PROVIDER_HOLD_CANCELABLE_STATES.has(state)) {
    return "RELEASE_ONCE";
  }
  if (!state) return "RETRIEVE_REQUIRED";
  return "RETRYABLE_PROVIDER_FAILURE";
}

/** Aggregate sweep/cron item outcomes — HTTP 200 must not hide per-item failure. */
export function summarizeHoldSweepItemOutcomes(
  items: Array<{ ok?: boolean; skipped?: boolean; outcome?: string; status?: string }>,
): {
  item_count: number;
  item_failure_count: number;
  item_success_count: number;
  cron_http_success_hides_item_failure: boolean;
  overall_ok: boolean;
} {
  let failures = 0;
  let successes = 0;
  for (const item of items) {
    const outcome = String(item.outcome ?? item.status ?? "").toUpperCase();
    const failed =
      item.ok === false ||
      outcome.includes("FAILED") ||
      outcome === "PROVIDER_FAILED" ||
      outcome === "LOCAL_PERSIST_FAILED";
    if (failed) failures += 1;
    else successes += 1;
  }
  return {
    item_count: items.length,
    item_failure_count: failures,
    item_success_count: successes,
    cron_http_success_hides_item_failure: failures > 0,
    overall_ok: failures === 0,
  };
}
