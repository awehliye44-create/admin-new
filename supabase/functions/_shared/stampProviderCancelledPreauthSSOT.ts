/**
 * BR2 — Provider-authoritative stamp when a create-preauth Revolut order is
 * cancelled before trip create.
 *
 * Distinguishes:
 * - cancellation without authorisation (order never AUTHORISED) → status cancelled,
 *   hold_release_state stays null, hold_terminal_reason=cancelled_before_authorisation
 * - release of an authorised hold → hold_release_state=released with provider
 *   evidence when available (never invent released_amount from auth arithmetic)
 *
 * Idempotent on metadata.cancellation_class. No historical backfill mutations.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { mutatePaymentSession } from "./paymentSessionMutationCore.ts";
import { extractConfirmedReleaseAmountPence } from "./paymentHoldProviderTerminalPure.ts";
import { toDbPaymentSessionStatus } from "./revolutPaymentHoldSSOT.ts";

export const CANCEL_WITHOUT_AUTH_REASON = "cancelled_before_authorisation";
export const CANCEL_AUTHORISED_HOLD_REASON = "provider_cancelled_authorised_hold";

const AUTH_STATES = new Set([
  "AUTHORISED",
  "AUTHORIZED",
  "COMPLETED",
  "CAPTURED",
]);

function upper(v: unknown): string {
  return String(v ?? "").trim().toUpperCase();
}

function lower(v: unknown): string {
  return String(v ?? "").trim().toLowerCase();
}

/** True when provider payload or prior local state shows a confirmed authorisation. */
export function providerOrderWasAuthorised(args: {
  priorProviderState?: string | null;
  providerPayload?: Record<string, unknown> | null;
}): boolean {
  if (AUTH_STATES.has(upper(args.priorProviderState))) return true;
  const payload = args.providerPayload;
  if (!payload) return false;
  if (AUTH_STATES.has(upper(payload.state))) return true;
  const payments = Array.isArray(payload.payments) ? payload.payments : [];
  for (const p of payments) {
    if (!p || typeof p !== "object") continue;
    const row = p as Record<string, unknown>;
    const authAmt = Number(row.authorised_amount ?? row.authorized_amount ?? 0);
    if (Number.isFinite(authAmt) && authAmt > 0) return true;
    if (AUTH_STATES.has(upper(row.state))) return true;
  }
  const authAmt = Number(
    payload.authorised_amount ?? payload.authorized_amount ?? 0,
  );
  return Number.isFinite(authAmt) && authAmt > 0;
}

export type ProviderCancelledPreauthClassification = {
  cancellationClass: "without_authorisation" | "authorised_hold_release";
  holdTerminalReason: string;
  /** null = no hold was released (never authorised). */
  holdReleaseState: "released" | null;
  releasedAmountPence: number | null;
  /** Local session status target. */
  status: "cancelled" | "released";
  skip: boolean;
  skipReason?: string;
};

export function classifyProviderCancelledPreauthStamp(args: {
  priorProviderState?: string | null;
  priorHoldReleaseState?: string | null;
  priorHoldTerminalReason?: string | null;
  priorStatus?: string | null;
  priorMetadata?: Record<string, unknown> | null;
  providerPayload?: Record<string, unknown> | null;
}): ProviderCancelledPreauthClassification {
  const meta = args.priorMetadata && typeof args.priorMetadata === "object"
    ? args.priorMetadata
    : {};
  const existingClass = String(meta.cancellation_class ?? "").trim();
  if (
    existingClass === "without_authorisation" ||
    existingClass === "authorised_hold_release"
  ) {
    return {
      cancellationClass: existingClass as
        | "without_authorisation"
        | "authorised_hold_release",
      holdTerminalReason: String(
        args.priorHoldTerminalReason ?? existingClass,
      ),
      holdReleaseState: lower(args.priorHoldReleaseState) === "released"
        ? "released"
        : null,
      releasedAmountPence: null,
      status: existingClass === "authorised_hold_release" ? "released" : "cancelled",
      skip: true,
      skipReason: "already_stamped",
    };
  }

  const holdAlready = lower(args.priorHoldReleaseState) === "released";
  const terminal = String(args.priorHoldTerminalReason ?? "").trim();
  if (
    holdAlready &&
    (terminal === CANCEL_AUTHORISED_HOLD_REASON ||
      terminal === CANCEL_WITHOUT_AUTH_REASON)
  ) {
    return {
      cancellationClass: terminal === CANCEL_WITHOUT_AUTH_REASON
        ? "without_authorisation"
        : "authorised_hold_release",
      holdTerminalReason: terminal,
      holdReleaseState: "released",
      releasedAmountPence: null,
      status: "released",
      skip: true,
      skipReason: "hold_already_released",
    };
  }

  const wasAuth = providerOrderWasAuthorised({
    priorProviderState: args.priorProviderState,
    providerPayload: args.providerPayload,
  });

  if (!wasAuth) {
    return {
      cancellationClass: "without_authorisation",
      holdTerminalReason: CANCEL_WITHOUT_AUTH_REASON,
      holdReleaseState: null,
      releasedAmountPence: null,
      status: "cancelled",
      skip: false,
    };
  }

  const explicit = extractConfirmedReleaseAmountPence(args.providerPayload ?? null);
  return {
    cancellationClass: "authorised_hold_release",
    holdTerminalReason: CANCEL_AUTHORISED_HOLD_REASON,
    holdReleaseState: "released",
    releasedAmountPence: explicit != null && explicit > 0 ? explicit : null,
    status: "released",
    skip: false,
  };
}

export type StampProviderCancelledPreauthResult = {
  applied: boolean;
  skipped: boolean;
  classification: ProviderCancelledPreauthClassification;
  sessionId: string | null;
};

/**
 * Persist cancel / release stamp for a create-preauth orphan or webhook CANCELLED.
 * Provider payload is authoritative for whether a hold ever existed.
 */
export async function stampProviderCancelledPreauthSession(args: {
  supabase: SupabaseClient;
  sessionId?: string | null;
  clientActionId?: string | null;
  providerOrderId: string;
  reason: string;
  evidenceSource: string;
  providerPayload?: Record<string, unknown> | null;
  /** When true, only fill terminal fields — never flip captured/completed. */
  allowStatusAdvance?: boolean;
}): Promise<StampProviderCancelledPreauthResult> {
  let sessionQuery = args.supabase
    .from("payment_sessions")
    .select(
      "id, status, provider_state, hold_release_state, hold_terminal_reason, released_amount_pence, metadata, captured_amount_pence, trip_id",
    );
  if (args.sessionId) {
    sessionQuery = sessionQuery.eq("id", args.sessionId);
  } else if (args.clientActionId) {
    sessionQuery = sessionQuery.eq("client_action_id", args.clientActionId);
  } else {
    sessionQuery = sessionQuery.eq("provider_order_id", args.providerOrderId);
  }
  const { data: session } = await sessionQuery.maybeSingle();

  if (!session?.id) {
    const empty = classifyProviderCancelledPreauthStamp({
      providerPayload: args.providerPayload,
    });
    return {
      applied: false,
      skipped: true,
      classification: { ...empty, skip: true, skipReason: "session_not_found" },
      sessionId: null,
    };
  }

  const statusLower = lower(session.status);
  if (
    ["captured", "completed", "refunded"].includes(statusLower) ||
    Number(session.captured_amount_pence ?? 0) > 0
  ) {
    const blocked = classifyProviderCancelledPreauthStamp({
      priorProviderState: session.provider_state as string | null,
      priorHoldReleaseState: session.hold_release_state as string | null,
      priorHoldTerminalReason: session.hold_terminal_reason as string | null,
      priorStatus: session.status as string | null,
      priorMetadata: session.metadata as Record<string, unknown> | null,
      providerPayload: args.providerPayload,
    });
    return {
      applied: false,
      skipped: true,
      classification: {
        ...blocked,
        skip: true,
        skipReason: "session_already_settled",
      },
      sessionId: String(session.id),
    };
  }

  const classification = classifyProviderCancelledPreauthStamp({
    priorProviderState: session.provider_state as string | null,
    priorHoldReleaseState: session.hold_release_state as string | null,
    priorHoldTerminalReason: session.hold_terminal_reason as string | null,
    priorStatus: session.status as string | null,
    priorMetadata: session.metadata as Record<string, unknown> | null,
    providerPayload: args.providerPayload,
  });

  if (classification.skip) {
    return {
      applied: false,
      skipped: true,
      classification,
      sessionId: String(session.id),
    };
  }

  const now = new Date().toISOString();
  const priorMeta =
    session.metadata && typeof session.metadata === "object"
      ? { ...(session.metadata as Record<string, unknown>) }
      : {};
  const metadata = {
    ...priorMeta,
    cancellation_class: classification.cancellationClass,
    cancel_stamp_reason: args.reason,
    cancel_stamp_source: args.evidenceSource,
    cancel_stamped_at: now,
    cancel_provider_state: args.providerPayload
      ? upper(args.providerPayload.state) || null
      : null,
  };

  const patch: Record<string, unknown> = {
    provider_state: "CANCELLED",
    provider_state_verified_at: now,
    provider_state_verified_by: args.evidenceSource,
    hold_terminal_reason: classification.holdTerminalReason,
    failure_reason: args.reason.slice(0, 500),
    metadata,
    updated_at: now,
  };

  if (classification.holdReleaseState === "released") {
    patch.hold_release_state = "released";
    patch.released_at = now;
    patch.provider_release_reference = args.providerOrderId;
    patch.release_failure_reason = null;
    if (classification.releasedAmountPence != null) {
      patch.released_amount_pence = classification.releasedAmountPence;
      patch.release_evidence_status = "CONFIRMED";
      patch.release_evidence_source = args.evidenceSource;
      patch.release_verified_at = now;
    } else {
      patch.release_evidence_status = "AMOUNT_UNCONFIRMED";
      patch.release_evidence_source = args.evidenceSource;
      patch.release_verified_at = now;
    }
  }

  const allowAdvance = args.allowStatusAdvance !== false;
  if (allowAdvance) {
    patch.status = toDbPaymentSessionStatus(classification.status);
  }

  const mutate = await mutatePaymentSession(
    args.supabase,
    { sessionId: String(session.id) },
    patch,
    "ssot",
  );
  if (!mutate.ok) {
    console.warn("[stampProviderCancelledPreauth] patch failed", mutate.error);
    return {
      applied: false,
      skipped: false,
      classification,
      sessionId: String(session.id),
    };
  }

  return {
    applied: true,
    skipped: false,
    classification,
    sessionId: String(session.id),
  };
}
