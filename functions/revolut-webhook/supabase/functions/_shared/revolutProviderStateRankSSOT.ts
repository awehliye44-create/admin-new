/**
 * Revolut provider_state ranking — stronger terminal states must not regress.
 * Edge + contract tests SSOT for Slice 1 orphan/webhook guards.
 *
 * Ranks operate on the canonical lifecycle vocabulary
 * (see paymentSessionLifecycleStateSSOT.normalizeLifecycleProviderState).
 * PAYMENT_FAILED / DECLINED share FAILED rank (10).
 */
import {
  isCanonicalTerminalNegative,
  normalizeLifecycleProviderState,
} from "./paymentSessionLifecycleStateSSOT.ts";

export function revolutProviderStateRank(state: string | null | undefined): number {
  const s = normalizeLifecycleProviderState(state);
  if (s === "COMPLETED" || s === "CAPTURED") return 50;
  if (s === "AUTHORISED") return 40;
  if (s === "PROCESSING" || s === "AUTHENTICATION_CHALLENGE") return 20;
  if (s === "CANCELLED" || s === "FAILED" || s === "DECLINED") return 10;
  return 0;
}

export function isRevolutProviderStateRegression(
  priorState: string | null | undefined,
  incomingState: string | null | undefined,
): boolean {
  const priorN = normalizeLifecycleProviderState(priorState);
  const incomingN = normalizeLifecycleProviderState(incomingState);
  if (priorN === "UNKNOWN" || incomingN === "UNKNOWN") return false;

  // Sticky terminal-negative: FAILED/DECLINED/CANCELLED must not be overwritten
  // by later in-flight PROCESSING (rank 20 > 10 would otherwise look like progress).
  if (
    isCanonicalTerminalNegative(priorN) &&
    (incomingN === "PROCESSING" || incomingN === "AUTHENTICATION_CHALLENGE")
  ) {
    return true;
  }

  const prior = revolutProviderStateRank(priorN);
  const incoming = revolutProviderStateRank(incomingN);
  return prior > 0 && incoming > 0 && incoming < prior;
}
