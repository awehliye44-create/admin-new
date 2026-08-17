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
  provider_state_verified_at?: string | null;
  purpose?: string | null;
};

/**
 * Wallet posting is allowed only when Payment Sessions confirms a verified capture.
 * Never use trips.payment_status as the capture gate.
 */
export function paymentSessionAllowsWalletPosting(
  session: PaymentSessionCaptureGate | null | undefined,
): boolean {
  if (!session) return false;
  if (String(session.purpose ?? "").toUpperCase() === "PAYMENT_RECOVERY") return false;
  const captured = Math.round(Number(session.captured_amount_pence) || 0);
  if (captured <= 0) return false;
  const status = String(session.status ?? "").trim().toLowerCase();
  if (status !== "captured" && status !== "completed") return false;
  const state = String(session.provider_state ?? "").trim().toUpperCase();
  if (state !== "COMPLETED" && state !== "CAPTURED") return false;
  if (!String(session.provider_state_verified_at ?? "").trim()) return false;
  return true;
}
