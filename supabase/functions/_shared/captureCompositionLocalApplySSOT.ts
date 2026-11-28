/**
 * Local application of immutable capture composition after terminal provider GET.
 *
 * Provider capture total may include fare + tip + receivable (+ never buffer in target).
 * Trip economic stamps / TEN / commission must use trip_fare_component only.
 * Receivable settlement must use receivable_component only.
 *
 * Never rolls back provider capture evidence when a local application fails.
 */
export const LOCAL_APPLICATION_INCOMPLETE = "LOCAL_APPLICATION_INCOMPLETE" as const;
export type CaptureCompositionComponents = {
  trip_fare_component_pence: number;
  tip_component_pence: number;
  receivable_component_pence: number;
  preauth_buffer_component_pence: number;
  provider_capture_target_pence: number;
};

export function nonNeg(n: unknown): number {
  const v = Math.round(Number(n) || 0);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** Pure: extract components from a payment session row + metadata. */
export function readCaptureCompositionComponents(session: {
  trip_fare_component_pence?: number | null;
  tip_component_pence?: number | null;
  receivable_component_pence?: number | null;
  buffer_pence?: number | null;
  provider_capture_target_pence?: number | null;
  metadata?: Record<string, unknown> | null;
} | null | undefined): CaptureCompositionComponents | null {
  if (!session) return null;
  const meta = session.metadata && typeof session.metadata === "object"
    ? session.metadata
    : {};
  const tripFare = nonNeg(
    session.trip_fare_component_pence ?? meta.trip_fare_component_pence,
  );
  const tip = nonNeg(session.tip_component_pence ?? meta.tip_component_pence);
  const recv = nonNeg(
    session.receivable_component_pence ?? meta.receivable_component_pence,
  );
  const buffer = nonNeg(
    meta.preauth_buffer_component_pence ?? session.buffer_pence,
  );
  const target = nonNeg(
    session.provider_capture_target_pence ?? meta.provider_capture_target_pence,
  );
  if (tripFare <= 0 && tip <= 0 && recv <= 0 && target <= 0) return null;
  return {
    trip_fare_component_pence: tripFare,
    tip_component_pence: tip,
    receivable_component_pence: recv,
    preauth_buffer_component_pence: buffer,
    provider_capture_target_pence: target > 0
      ? target
      : tripFare + tip + recv,
  };
}

export type ProviderSettleEvidenceInput = {
  orderId: string;
  terminalState: "COMPLETED" | "CAPTURED";
  confirmedCapturedPence: number;
  amountFromProviderGet: true;
};

/** Build settle evidence only from terminal GET confirmation. */
export function buildProviderSettleEvidenceFromGet(args: {
  orderId: string;
  terminalState: string;
  confirmedCapturedPence: number;
}): ProviderSettleEvidenceInput | null {
  const state = String(args.terminalState ?? "").toUpperCase();
  if (state !== "COMPLETED" && state !== "CAPTURED") return null;
  const captured = nonNeg(args.confirmedCapturedPence);
  if (captured <= 0) return null;
  const orderId = String(args.orderId ?? "").trim();
  if (!orderId) return null;
  return {
    orderId,
    terminalState: state as "COMPLETED" | "CAPTURED",
    confirmedCapturedPence: captured,
    amountFromProviderGet: true,
  };
}

export type LocalApplicationOutcome = {
  provider_capture_persisted: boolean;
  trip_stamps_applied: boolean;
  receivables_settled: boolean;
  ten_posted_or_verified: boolean;
  incomplete: boolean;
  incomplete_reason: string | null;
  manual_review: boolean;
};
