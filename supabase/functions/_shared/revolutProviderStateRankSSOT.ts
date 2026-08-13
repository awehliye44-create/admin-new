/**
 * Revolut provider_state ranking — stronger terminal states must not regress.
 * Edge + contract tests SSOT for Slice 1 orphan/webhook guards.
 */
export function revolutProviderStateRank(state: string | null | undefined): number {
  const s = String(state ?? "").trim().toUpperCase();
  if (s === "COMPLETED" || s === "CAPTURED") return 50;
  if (s === "AUTHORISED" || s === "AUTHORIZED") return 40;
  if (s === "PAYMENT_AUTHENTICATED" || s === "PENDING" || s === "PROCESSING") return 20;
  if (s === "CANCELLED" || s === "CANCELED" || s === "FAILED") return 10;
  return 0;
}

export function isRevolutProviderStateRegression(
  priorState: string | null | undefined,
  incomingState: string | null | undefined,
): boolean {
  const prior = revolutProviderStateRank(priorState);
  const incoming = revolutProviderStateRank(incomingState);
  return prior > 0 && incoming > 0 && incoming < prior;
}
