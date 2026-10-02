/**
 * Customer fare-decision hold — a timely tap owns the negotiation until
 * increment + commit finish. Timeout must not rematch an in-flight decision.
 *
 * Existing marker: ride_offers.responded_at (no new status, no migration).
 */

export const NEGOTIATION_DECISION_ABANDON_MS = 90_000;

export function shouldTimeoutWaitingCustomer(input: {
  negotiationStatus: string | null | undefined;
  customerRespondByIso: string | null | undefined;
  respondedAtIso: string | null | undefined;
  nowMs: number;
}): boolean {
  if (input.negotiationStatus !== "waiting_customer") return false;
  if (input.respondedAtIso) return false;
  const deadlineMs = input.customerRespondByIso
    ? Date.parse(input.customerRespondByIso)
    : Number.NaN;
  if (!Number.isFinite(deadlineMs)) return false;
  return deadlineMs < input.nowMs;
}

/** Existing 90s stuck-negotiation backstop, applied to abandoned in-flight holds. */
export function shouldTimeoutAbandonedDecisionHold(input: {
  negotiationStatus: string | null | undefined;
  respondedAtIso: string | null | undefined;
  nowMs: number;
  abandonAfterMs?: number;
}): boolean {
  if (input.negotiationStatus !== "waiting_customer") return false;
  if (!input.respondedAtIso) return false;
  const respondedMs = Date.parse(input.respondedAtIso);
  if (!Number.isFinite(respondedMs)) return false;
  return input.nowMs - respondedMs >= (input.abandonAfterMs ?? NEGOTIATION_DECISION_ABANDON_MS);
}

export function customerSubmittedBeforeDeadline(input: {
  submittedAtMs: number;
  deadlineMs: number | null;
}): boolean {
  if (input.deadlineMs == null || !Number.isFinite(input.deadlineMs)) return true;
  return input.submittedAtMs <= input.deadlineMs;
}

export type ClaimCustomerNegotiationDecisionResult =
  | { ok: true; alreadyClaimed: boolean }
  | { ok: false; reason: "expired" | "invalid_state" };

type OfferHoldRow = {
  id?: string;
  negotiation_status?: string | null;
  responded_at?: string | null;
};

type HoldQuery = {
  select: (cols: string) => HoldQuery;
  update: (values: Record<string, unknown>) => HoldQuery;
  eq: (col: string, val: string) => HoldQuery;
  is: (col: string, val: null) => HoldQuery;
  maybeSingle: () => Promise<{ data: OfferHoldRow | null }>;
};

export async function claimCustomerNegotiationDecision(
  supabase: { from: (table: string) => HoldQuery },
  offerId: string,
  submittedAtIso: string,
): Promise<ClaimCustomerNegotiationDecisionResult> {
  const { data: current } = await supabase
    .from("ride_offers")
    .select("negotiation_status, responded_at")
    .eq("id", offerId)
    .maybeSingle();

  if (!current) return { ok: false, reason: "invalid_state" };
  if (current.responded_at) return { ok: true, alreadyClaimed: true };
  if (current.negotiation_status === "timeout_customer") {
    return { ok: false, reason: "expired" };
  }
  if (current.negotiation_status !== "waiting_customer") {
    return { ok: false, reason: "invalid_state" };
  }

  const { data: updated } = await supabase
    .from("ride_offers")
    .update({
      responded_at: submittedAtIso,
      updated_at: submittedAtIso,
    })
    .eq("id", offerId)
    .eq("negotiation_status", "waiting_customer")
    .is("responded_at", null)
    .select("id")
    .maybeSingle();

  if (updated?.id) return { ok: true, alreadyClaimed: false };

  const { data: raced } = await supabase
    .from("ride_offers")
    .select("negotiation_status, responded_at")
    .eq("id", offerId)
    .maybeSingle();
  if (raced?.responded_at) return { ok: true, alreadyClaimed: true };
  if (raced?.negotiation_status === "timeout_customer") {
    return { ok: false, reason: "expired" };
  }
  return { ok: false, reason: "invalid_state" };
}
