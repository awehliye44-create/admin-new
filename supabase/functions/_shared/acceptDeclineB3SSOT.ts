/**
 * B3 — Accept / Decline critical-path parallelism (isolated / flag-gated).
 *
 * Default OFF (`ACCEPT_DECLINE_B3` unset/0). When ON:
 * - accept-offer: eligibility ∥ offer lookup; pre-RPC expands to commitments +
 *   stacked current-trip remaining; gate reuses preloaded commitments.
 * - scheduled-ride-action accept: one trip SELECT; commitment ∥ journey ∥ wallet
 *   gates before accept_scheduled_ride.
 *
 * Never weakens atomic RPC exclusivity, TTL, payment cover, or optimistic success.
 * Fail closed: unknown/missing flag → OFF (legacy sequential ordering).
 */

export const ACCEPT_DECLINE_B3_FLAG = "ACCEPT_DECLINE_B3";

function readAcceptDeclineB3FlagFromEnv(): string | undefined {
  try {
    if (typeof Deno === "undefined") return undefined;
    return Deno.env.get(ACCEPT_DECLINE_B3_FLAG) ?? undefined;
  } catch {
    // deno test without --allow-env → treat as unset (default OFF).
    return undefined;
  }
}

export function isAcceptDeclineB3Enabled(
  raw: string | undefined | null = readAcceptDeclineB3FlagFromEnv(),
): boolean {
  if (raw == null) return false;
  const v = String(raw).trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}
