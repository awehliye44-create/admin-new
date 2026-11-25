/**
 * Durable financial operation identity, fencing, and POST safety.
 *
 * Lease expiry alone never authorises a new financial POST.
 * provider_post_inflight ⇒ reconcile-only until definitive provider evidence.
 */

export type FinancialOpType = "INCREMENT" | "CAPTURE" | "RECONCILE" | "RELEASE" | "SETTLE";

export type FinancialOpState =
  | "INCREMENT_REQUESTED"
  | "INCREMENT_PENDING"
  | "INCREMENT_UNKNOWN"
  | "COVER_CONFIRMED"
  | "INCREMENT_DECLINED"
  | "CAPTURE_REQUESTED"
  | "CAPTURE_PENDING"
  | "CAPTURE_UNKNOWN"
  | "PARTIALLY_CAPTURED"
  | "FULLY_CAPTURED"
  | "CAPTURE_FAILED"
  | "RECOVERY_REQUIRED"
  | "RECONCILING"
  | "SETTLED"
  | "SETTLED_PARTIAL"
  | "CANCELLED"
  | "SUPERSEDED";

const TERMINAL_STATES = new Set<FinancialOpState>([
  "COVER_CONFIRMED",
  "INCREMENT_DECLINED",
  "FULLY_CAPTURED",
  "PARTIALLY_CAPTURED",
  "CAPTURE_FAILED",
  "SETTLED",
  "SETTLED_PARTIAL",
  "CANCELLED",
  "SUPERSEDED",
]);

export function isTerminalFinancialOpState(state: string | null | undefined): boolean {
  return TERMINAL_STATES.has(String(state ?? "") as FinancialOpState);
}

/** Unique per worker attempt — never reused as logical uniqueness alone. */
export function buildExecutionId(args: {
  opType: FinancialOpType;
  tripId: string;
  ulid: string;
}): string {
  return `${args.opType}:${String(args.tripId).trim()}:${String(args.ulid).trim()}`;
}

/**
 * Logical idempotency key — DB unique among active ops.
 * Includes snapshot version / epoch so revisited targets after decrease are distinct.
 */
export type CapturePurpose = "fare" | "terminal_fee" | "orphan_fee" | "lifecycle_fee";

export function buildLogicalIdempotencyKey(args: {
  opType: FinancialOpType;
  paymentSessionId: string;
  providerOrderId: string;
  targetAmountPence: number;
  payableSnapshotVersion: number;
  epoch?: number | null;
  /** Distinguishes fare vs fee captures on the same order (never mix settlement). */
  purpose?: CapturePurpose | string | null;
}): string {
  const epoch = args.epoch != null && Number.isFinite(args.epoch) ? Math.round(args.epoch) : 0;
  const purpose = String(args.purpose ?? "fare").trim() || "fare";
  return [
    args.opType,
    purpose,
    String(args.paymentSessionId).trim(),
    String(args.providerOrderId).trim(),
    Math.round(Number(args.targetAmountPence) || 0),
    `v${Math.round(Number(args.payableSnapshotVersion) || 0)}`,
    `e${epoch}`,
  ].join(":");
}

export type PostDispatchSafety =
  | { action: "allow_post" }
  | { action: "reconcile_only"; reason: string }
  | { action: "busy"; reason: string };

/**
 * Decide whether a new provider POST is allowed.
 * Inflight / unresolved prior op → reconcile only.
 * Lease expiry alone never allows POST.
 */
export function decideProviderPostSafety(args: {
  priorOp: {
    state: string;
    provider_post_inflight: boolean;
    lease_expires_at?: string | null;
    logical_idempotency_key: string;
  } | null;
  requestedLogicalKey: string;
  leaseExpired?: boolean;
}): PostDispatchSafety {
  const prior = args.priorOp;
  if (!prior) return { action: "allow_post" };

  if (prior.provider_post_inflight === true) {
    return {
      action: "reconcile_only",
      reason: "provider_post_inflight",
    };
  }

  if (!isTerminalFinancialOpState(prior.state)) {
    const ambiguous = [
      "INCREMENT_PENDING",
      "INCREMENT_UNKNOWN",
      "CAPTURE_PENDING",
      "CAPTURE_UNKNOWN",
      "RECONCILING",
      "INCREMENT_REQUESTED",
      "CAPTURE_REQUESTED",
    ].includes(String(prior.state));
    if (ambiguous) {
      return {
        action: "reconcile_only",
        reason: `unresolved_state:${prior.state}`,
      };
    }
  }

  if (
    prior.logical_idempotency_key === args.requestedLogicalKey
    && !isTerminalFinancialOpState(prior.state)
  ) {
    return { action: "busy", reason: "active_logical_operation" };
  }

  // Lease expiry must NEVER independently authorise a new POST.
  if (args.leaseExpired === true && prior.provider_post_inflight) {
    return { action: "reconcile_only", reason: "lease_expired_inflight" };
  }

  return { action: "allow_post" };
}

/** Legacy workers without fence/execution_id must not mutate financial confirmations. */
export function assertModernFinancialWriter(args: {
  executionId?: string | null;
  fence?: string | null;
  schemaAware: boolean;
}): { ok: true } | { ok: false; code: "LEGACY_WRITER_BLOCKED" } {
  if (!args.schemaAware) {
    return { ok: false, code: "LEGACY_WRITER_BLOCKED" };
  }
  if (!String(args.executionId ?? "").trim() || !String(args.fence ?? "").trim()) {
    return { ok: false, code: "LEGACY_WRITER_BLOCKED" };
  }
  return { ok: true };
}
