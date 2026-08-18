/**
 * Historical boundary for canonical wallet posting recovery.
 *
 * Fresh capture in this request may always post TRIP_EARNING_NET.
 * Already-captured recovery mutates only trips captured at/after WALLET_POSTING_ACTIVATED_AT.
 * Unset activation → recovery is detect-only (no historical credits).
 * Financial Reconciliation never posts or retries wallet money.
 */

export function readWalletPostingActivatedAtMs(): number | null {
  try {
    const raw = Deno.env.get("WALLET_POSTING_ACTIVATED_AT")?.trim() ?? "";
    if (!raw) return null;
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

export function isHistoricalWalletTrip(args: {
  capture_completed_at_iso?: string | null;
  trip_created_at_iso?: string | null;
  activated_at_ms?: number | null;
}): boolean {
  const activatedMs = args.activated_at_ms !== undefined
    ? args.activated_at_ms
    : readWalletPostingActivatedAtMs();
  if (activatedMs == null) return true;

  const captureMs = Date.parse(String(args.capture_completed_at_iso ?? ""));
  if (Number.isFinite(captureMs)) return captureMs < activatedMs;

  const createdMs = Date.parse(String(args.trip_created_at_iso ?? ""));
  if (Number.isFinite(createdMs)) return createdMs < activatedMs;

  return true;
}

/** Canonical already-captured recovery may insert TRIP_EARNING_NET only for post-activation trips. */
export function mayRetryWalletPosting(args: {
  capture_completed_at_iso?: string | null;
  trip_created_at_iso?: string | null;
  activated_at_ms?: number | null;
}): boolean {
  return !isHistoricalWalletTrip(args);
}

export type PaymentSessionCaptureGate = {
  status?: string | null;
  provider_state?: string | null;
  captured_amount_pence?: number | null;
  captured_at?: string | null;
  provider_state_verified_at?: string | null;
  purpose?: string | null;
  refunded_amount_pence?: number | null;
  released_amount_pence?: number | null;
  hold_release_state?: string | null;
  hold_terminal_reason?: string | null;
};

/**
 * Wallet posting is allowed only when Payment Sessions is in a consistent captured state.
 * Never use trips.payment_status as the capture gate.
 *
 * A session is considered a verified capture when ALL of the following hold:
 *   - status is "captured" (Payment Sessions lifecycle is consistent)
 *   - provider_state is COMPLETED or CAPTURED (Revolut terminal states)
 *   - provider_state_verified_at is present
 *   - captured_amount_pence > 0
 *   - purpose is not PAYMENT_RECOVERY
 *   - refunded_amount_pence is 0 / null
 *   - not released (released_amount_pence / hold_release_state / hold_terminal_reason)
 *
 * A session with status="trip_created" + provider_state="COMPLETED" is a lifecycle mismatch.
 * The caller must finalize the session to "captured" before calling this gate.
 * This gate must not accept contradictory state silently.
 */
export function paymentSessionAllowsWalletPosting(
  session: PaymentSessionCaptureGate | null | undefined,
): boolean {
  if (!session) return false;
  if (String(session.purpose ?? "").toUpperCase() === "PAYMENT_RECOVERY") return false;
  const captured = Math.round(Number(session.captured_amount_pence) || 0);
  if (captured <= 0) return false;
  if (Math.round(Number(session.refunded_amount_pence) || 0) > 0) return false;
  if (Math.round(Number(session.released_amount_pence) || 0) > 0) return false;
  const releaseState = String(session.hold_release_state ?? "").trim().toUpperCase();
  if (releaseState.includes("RELEASE")) return false;
  const terminal = String(session.hold_terminal_reason ?? "").trim().toUpperCase();
  if (terminal.includes("RELEASE") && !terminal.includes("CAPTURE")) return false;
  const status = String(session.status ?? "").trim().toLowerCase();
  if (status !== "captured") return false;
  const state = String(session.provider_state ?? "").trim().toUpperCase();
  if (state !== "COMPLETED" && state !== "CAPTURED") return false;
  if (!String(session.provider_state_verified_at ?? "").trim()) return false;
  return true;
}

/**
 * Detect a Payment Sessions lifecycle mismatch: the PS has provider evidence of a capture
 * (provider_state COMPLETED/CAPTURED, captured_amount_pence > 0, provider_state_verified_at)
 * but the workflow status column was not advanced to "captured" — this is not consistent.
 * The PS must be finalized before wallet posting can proceed.
 */
export function isPaymentSessionLifecycleMismatch(
  session: PaymentSessionCaptureGate | null | undefined,
): boolean {
  if (!session) return false;
  const status = String(session.status ?? "").trim().toLowerCase();
  if (status === "captured") return false; // already consistent
  const captured = Math.round(Number(session.captured_amount_pence) || 0);
  if (captured <= 0) return false;
  const state = String(session.provider_state ?? "").trim().toUpperCase();
  if (state !== "COMPLETED" && state !== "CAPTURED") return false;
  if (!String(session.provider_state_verified_at ?? "").trim()) return false;
  return true;
}
