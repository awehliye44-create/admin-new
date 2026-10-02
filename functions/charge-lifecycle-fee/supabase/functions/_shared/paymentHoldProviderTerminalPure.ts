/**
 * Pure helpers for provider-terminal hold persistence (unit-testable, no Deno).
 */

export function extractConfirmedReleaseAmountPence(
  providerPayload: Record<string, unknown> | null | undefined,
): number | null {
  if (!providerPayload) return null;
  const asPence = (raw: unknown): number | null => {
    if (raw == null) return null;
    if (typeof raw === "object" && raw !== null && "value" in (raw as object)) {
      const n = Number((raw as { value?: unknown }).value);
      if (Number.isFinite(n) && n > 0) return Math.round(n);
      return null;
    }
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.round(n);
    return null;
  };
  // Release only — never treat refunded_amount as residual release (Slice 3).
  // Never invent from authorised − captured (comparison-only elsewhere).
  const candidates = [
    providerPayload.cancelled_amount,
    providerPayload.canceled_amount,
    providerPayload.released_amount,
    providerPayload.amount_released,
  ];
  for (const c of candidates) {
    const n = asPence(c);
    if (n != null) return n;
  }
  const payments = Array.isArray(providerPayload.payments) ? providerPayload.payments : [];
  for (const p of payments) {
    if (!p || typeof p !== "object") continue;
    const payment = p as Record<string, unknown>;
    for (const key of [
      "cancelled_amount",
      "canceled_amount",
      "released_amount",
      "amount_released",
    ]) {
      const n = asPence(payment[key]);
      if (n != null) return n;
    }
  }
  return null;
}

/**
 * Capture amount from provider payload when state is CAPTURED/COMPLETED.
 * Prefer explicit capture fields; fall back to order amount only for terminal capture states.
 * Supports Revolut Merchant API shapes: flat minor units or `{ value, currency }`.
 */
export function extractConfirmedCaptureAmountPence(
  providerPayload: Record<string, unknown> | null | undefined,
  providerState?: string | null,
): number | null {
  if (!providerPayload) return null;
  const state = String(providerState ?? providerPayload.state ?? "").trim().toUpperCase();

  const asPence = (raw: unknown): number | null => {
    if (raw == null) return null;
    if (typeof raw === "object" && raw !== null && "value" in (raw as object)) {
      const n = Number((raw as { value?: unknown }).value);
      if (Number.isFinite(n) && n > 0) return Math.round(n);
      return null;
    }
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.round(n);
    return null;
  };

  const explicit = [
    providerPayload.captured_amount,
    providerPayload.completed_amount,
    providerPayload.capture_amount,
  ];
  for (const c of explicit) {
    const n = asPence(c);
    if (n != null) return n;
  }

  if (state === "CAPTURED" || state === "COMPLETED") {
    const fromPayments = Array.isArray(providerPayload.payments)
      ? providerPayload.payments
      : [];
    for (const p of fromPayments) {
      if (!p || typeof p !== "object") continue;
      const payment = p as Record<string, unknown>;
      const paymentState = String(payment.state ?? "").toUpperCase();
      if (paymentState && paymentState !== "COMPLETED" && paymentState !== "CAPTURED") continue;
      const n = asPence(payment.amount);
      if (n != null) return n;
    }
    for (const key of ["order_amount", "amount", "completed_amount"]) {
      const n = asPence(providerPayload[key]);
      if (n != null) return n;
    }
  }
  return null;
}

export function extractProviderCaptureId(
  providerPayload: Record<string, unknown> | null | undefined,
): string | null {
  if (!providerPayload) return null;
  const candidates = [
    providerPayload.capture_id,
    providerPayload.provider_capture_id,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  // Revolut payments[] entry may carry a distinct payment id used as capture evidence.
  const payments = providerPayload.payments;
  if (Array.isArray(payments) && payments.length > 0) {
    const first = payments[0];
    if (first && typeof first === "object") {
      const paymentId = (first as Record<string, unknown>).id;
      if (typeof paymentId === "string" && paymentId.trim()) return paymentId.trim();
    }
  }
  return null;
}

export function extractEventTimestamp(
  providerPayload: Record<string, unknown> | null | undefined,
  fallbackIso?: string,
): string {
  const raw = providerPayload?.updated_at
    ?? providerPayload?.completed_at
    ?? providerPayload?.cancelled_at
    ?? providerPayload?.canceled_at
    ?? null;
  if (typeof raw === "string" && raw.trim()) {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return fallbackIso ?? new Date().toISOString();
}

/** FAILED is terminal only when no hold remains (not CAPTURED / not still AUTHORISED). */
export function shouldPersistFailedAsTerminal(args: {
  providerStateRaw: string | null | undefined;
  sessionCapturedAt?: string | null;
  sessionReleasedAt?: string | null;
}): boolean {
  const upper = String(args.providerStateRaw ?? "").trim().toUpperCase();
  if (upper !== "FAILED") return false;
  if (args.sessionCapturedAt) return false;
  // Provider FAILED ⇒ authorisation did not remain; safe to mark released.
  return true;
}

export function buildReleasedSessionPatch(args: {
  holdTerminalReason: string;
  providerState: string;
  providerStateVerifiedBy: string;
  verifiedAt: string;
  confirmedReleaseAmountPence: number | null;
  metadata: Record<string, unknown>;
  idempotencyKey?: string | null;
}): Record<string, unknown> {
  const metadata = { ...args.metadata };
  metadata.provider_state = args.providerState;
  metadata.provider_state_verified_at = args.verifiedAt;
  metadata.provider_state_verified_by = args.providerStateVerifiedBy;
  if (args.idempotencyKey) {
    const keys = Array.isArray(metadata.provider_terminal_idempotency_keys)
      ? (metadata.provider_terminal_idempotency_keys as string[])
      : [];
    if (!keys.includes(args.idempotencyKey)) {
      metadata.provider_terminal_idempotency_keys = [...keys, args.idempotencyKey];
    }
  }

  const patch: Record<string, unknown> = {
    hold_terminal_reason: args.holdTerminalReason,
    hold_release_state: "released",
    release_failure_reason: null,
    provider_state: args.providerState,
    provider_state_verified_at: args.verifiedAt,
    provider_state_verified_by: args.providerStateVerifiedBy,
    metadata,
    updated_at: args.verifiedAt,
  };
  // Never infer released_amount_pence — only write when provider confirms.
  if (args.confirmedReleaseAmountPence != null) {
    patch.released_amount_pence = args.confirmedReleaseAmountPence;
  }
  return patch;
}

export function hasTerminalIdempotencyKey(
  metadata: Record<string, unknown> | null | undefined,
  idempotencyKey: string | null | undefined,
): boolean {
  if (!idempotencyKey || !metadata) return false;
  const keys = Array.isArray(metadata.provider_terminal_idempotency_keys)
    ? (metadata.provider_terminal_idempotency_keys as string[])
    : [];
  return keys.includes(idempotencyKey);
}

/** Gate for admin-hold-action before mutating. */
export function evaluateStaleHoldAction(args: {
  providerCanonical:
    | "CANCELLED"
    | "REVERTED"
    | "CAPTURED"
    | "REFUNDED"
    | "FAILED"
    | "ACTIVE_AUTHORISED"
    | "PENDING"
    | "PROCESSING"
    | "UNKNOWN"
    | null;
  sessionReleasedAt: string | null;
  sessionCapturedAt: string | null;
  inActiveQueue: boolean;
  action: "release" | "retry_release" | "retry_recovery";
  canRelease: boolean;
  canRetryRelease: boolean;
  canRetryRecovery: boolean;
}): {
  allow: boolean;
  already_resolved: boolean;
  reject_reason: string | null;
} {
  const terminalProvider = args.providerCanonical === "CANCELLED"
    || args.providerCanonical === "REVERTED"
    || args.providerCanonical === "CAPTURED"
    || args.providerCanonical === "REFUNDED"
    || args.providerCanonical === "FAILED";

  if (terminalProvider || args.sessionReleasedAt || args.sessionCapturedAt || !args.inActiveQueue) {
    return { allow: false, already_resolved: true, reject_reason: "already_resolved" };
  }

  const actionAllowed =
    (args.action === "release" && args.canRelease)
    || (args.action === "retry_release" && args.canRetryRelease)
    || (args.action === "retry_recovery" && args.canRetryRecovery);

  if (!actionAllowed) {
    return { allow: false, already_resolved: false, reject_reason: "action_not_permitted" };
  }

  return { allow: true, already_resolved: false, reject_reason: null };
}

export function canRefundCapturedHold(args: {
  attentionClass: string;
  capturedAt: string | null;
  fullyRefunded?: boolean;
}): boolean {
  if (args.attentionClass !== "CAPTURED") return false;
  if (!args.capturedAt) return false;
  if (args.fullyRefunded) return false;
  return true;
}
