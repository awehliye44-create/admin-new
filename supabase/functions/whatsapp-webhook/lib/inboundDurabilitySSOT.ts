/**
 * P6 M4 — WhatsApp durable inbound.
 *
 * `processed_at` means "workflow succeeded". A workflow failure must never set it,
 * otherwise the 23505 duplicate path treats the message as done and the customer
 * never gets a reply. Failure records `last_error`, releases the claim
 * (`processing_started_at = null`) and leaves the row retryable until the attempt
 * cap, enforced atomically by `claim_whatsapp_inbound_retry`.
 */

export const WHATSAPP_INBOUND_MAX_ATTEMPTS = 3;
/** A claim older than this is treated as a crashed worker and may be re-claimed. */
export const WHATSAPP_INBOUND_STALE_CLAIM_SECONDS = 120;
export const WHATSAPP_INBOUND_LAST_ERROR_MAX_CHARS = 500;

export const WHATSAPP_INBOUND_CLAIM_RPC = "claim_whatsapp_inbound_retry";

export const WHATSAPP_INBOUND_FAILURE_ACTION_RETRYABLE = "workflow_error_retryable";
export const WHATSAPP_INBOUND_FAILURE_ACTION_EXHAUSTED = "workflow_error_exhausted";

export function isInboundAttemptsExhausted(attemptCount: number): boolean {
  return Math.round(Number(attemptCount) || 0) >= WHATSAPP_INBOUND_MAX_ATTEMPTS;
}

export function truncateInboundError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "unknown_error");
  return raw.slice(0, WHATSAPP_INBOUND_LAST_ERROR_MAX_CHARS);
}

/** Failure patch — deliberately has NO processed_at. */
export function buildInboundFailurePatch(args: {
  attemptCount: number;
  error: unknown;
}): {
  last_error: string;
  processing_started_at: null;
  workflow_action: string;
} {
  return {
    last_error: truncateInboundError(args.error),
    processing_started_at: null,
    workflow_action: isInboundAttemptsExhausted(args.attemptCount)
      ? WHATSAPP_INBOUND_FAILURE_ACTION_EXHAUSTED
      : WHATSAPP_INBOUND_FAILURE_ACTION_RETRYABLE,
  };
}

/** Success patch — the ONLY patch that sets processed_at. */
export function buildInboundSuccessPatch(args: { workflowAction: string; nowIso: string }): {
  processed_at: string;
  workflow_action: string;
  last_error: null;
  processing_started_at: null;
} {
  return {
    processed_at: args.nowIso,
    workflow_action: args.workflowAction,
    last_error: null,
    processing_started_at: null,
  };
}
