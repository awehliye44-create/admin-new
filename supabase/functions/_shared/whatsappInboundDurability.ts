/**
 * WhatsApp durable inbound (P6 M4 + P7 M4) — shared by `whatsapp-webhook` and
 * `whatsapp-inbound-retry-sweep`.
 *
 * `processed_at` means "workflow succeeded". A workflow failure — a thrown error OR a
 * returned send-failure action (`*_send_failed`, `outbound_unconfigured`) — must never set
 * it, otherwise the duplicate path / retry sweep treats the message as done and the
 * customer never gets a reply. Failure records `last_error`, releases the claim
 * (`processing_started_at = null`) and leaves the row retryable until the attempt cap,
 * enforced atomically by `claim_whatsapp_inbound_retry`.
 *
 * On attempt exhaustion a durable alert is written to `payment_financial_events`
 * (`WHATSAPP_INBOUND_RETRY_EXHAUSTED`) so ops can query stranded customer messages.
 */
import { recordPaymentFinancialEvent } from "./paymentFinancialDiagnosticsSSOT.ts";

export const WHATSAPP_INBOUND_MAX_ATTEMPTS = 3;
/** A claim older than this is treated as a crashed worker and may be re-claimed. */
export const WHATSAPP_INBOUND_STALE_CLAIM_SECONDS = 120;
export const WHATSAPP_INBOUND_LAST_ERROR_MAX_CHARS = 500;

export const WHATSAPP_INBOUND_CLAIM_RPC = "claim_whatsapp_inbound_retry";

export const WHATSAPP_INBOUND_FAILURE_ACTION_RETRYABLE = "workflow_error_retryable";
export const WHATSAPP_INBOUND_FAILURE_ACTION_EXHAUSTED = "workflow_error_exhausted";

/** P7 M4: sweep only replays rows at least this old (Meta redelivery gets first chance). */
export const WHATSAPP_INBOUND_SWEEP_MIN_AGE_SECONDS = 120;
/** P7 M4: never replay a customer message older than this. */
export const WHATSAPP_INBOUND_SWEEP_MAX_AGE_HOURS = 24;
/** P7 M4: exhausted-without-alert audit window. */
export const WHATSAPP_INBOUND_EXHAUSTED_AUDIT_WINDOW_DAYS = 7;

export const WHATSAPP_INBOUND_RETRY_EXHAUSTED_EVENT = "WHATSAPP_INBOUND_RETRY_EXHAUSTED";

/** Workflow actions that are NOT a successful customer reply (nothing / not all was sent). */
export const WHATSAPP_INBOUND_KNOWN_SEND_FAILURE_ACTIONS: readonly string[] = [
  "outbound_unconfigured",
];

/**
 * True when `processWhatsAppInboundMessage` RETURNED (did not throw) an action that means the
 * outbound reply failed. Compound actions such as `welcome_sent:book_link_send_failed` count.
 */
export function isInboundSendFailureAction(action: string | null | undefined): boolean {
  const a = String(action ?? "").trim();
  if (!a) return false;
  if (a.endsWith("_send_failed")) return true;
  return WHATSAPP_INBOUND_KNOWN_SEND_FAILURE_ACTIONS.includes(a);
}

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

export function whatsappInboundExhaustedDedupeKey(metaMessageId: string): string {
  return `whatsapp_inbound_exhausted:${metaMessageId}`;
}

// deno-lint-ignore no-explicit-any
type ClientLike = any;

/**
 * Durable alert for a message that used all attempts without a successful reply.
 * Idempotent per meta_message_id. Never throws.
 */
export async function recordInboundExhaustedAlert(
  client: ClientLike,
  args: {
    metaMessageId: string;
    attemptCount: number;
    lastError: string | null;
    messageType?: string | null;
    source: string;
  },
): Promise<void> {
  const key = whatsappInboundExhaustedDedupeKey(args.metaMessageId);
  try {
    const { data: existing } = await client
      .from("payment_financial_events")
      .select("id")
      .eq("execution_id", key)
      .eq("event_type", WHATSAPP_INBOUND_RETRY_EXHAUSTED_EVENT)
      .limit(1)
      .maybeSingle();
    if (existing?.id) return;
  } catch (err) {
    console.error("[whatsapp-inbound] exhausted alert dedupe lookup failed (recording anyway)", String(err));
  }
  await recordPaymentFinancialEvent(client, {
    eventType: WHATSAPP_INBOUND_RETRY_EXHAUSTED_EVENT,
    opType: "whatsapp_inbound_retry",
    executionId: key,
    idempotencyReference: key,
    detail: {
      meta_message_id: args.metaMessageId,
      attempt_count: args.attemptCount,
      max_attempts: WHATSAPP_INBOUND_MAX_ATTEMPTS,
      message_type: args.messageType ?? null,
      last_error: args.lastError,
      source: args.source,
      customer_reply_sent: false,
    },
  });
}

/**
 * Mark processed ONLY after the workflow succeeded. Never call from a failure path.
 */
export async function markInboundProcessed(
  client: ClientLike,
  metaMessageId: string,
  workflowAction: string,
): Promise<void> {
  const { error } = await client
    .from("whatsapp_inbound_messages")
    .update(buildInboundSuccessPatch({
      workflowAction,
      nowIso: new Date().toISOString(),
    }))
    .eq("meta_message_id", metaMessageId)
    .is("processed_at", null);
  if (error) {
    console.error("[whatsapp-inbound] markInboundProcessed failed", {
      meta_message_id_prefix: metaMessageId.slice(0, 24),
      error: error.message,
    });
  }
}

/**
 * Failure: record error + release claim. processed_at stays NULL (retryable until cap).
 * When this attempt exhausts the cap, a durable alert is recorded.
 */
export async function recordInboundFailure(
  client: ClientLike,
  metaMessageId: string,
  attemptCount: number,
  error: unknown,
  opts?: { messageType?: string | null; source?: string },
): Promise<void> {
  const patch = buildInboundFailurePatch({ attemptCount, error });
  const { error: updateErr } = await client
    .from("whatsapp_inbound_messages")
    .update(patch)
    .eq("meta_message_id", metaMessageId)
    .is("processed_at", null);
  if (updateErr) {
    console.error("[whatsapp-inbound] recordInboundFailure failed", {
      meta_message_id_prefix: metaMessageId.slice(0, 24),
      error: updateErr.message,
    });
  }
  if (isInboundAttemptsExhausted(attemptCount)) {
    await recordInboundExhaustedAlert(client, {
      metaMessageId,
      attemptCount,
      lastError: patch.last_error,
      messageType: opts?.messageType ?? null,
      source: opts?.source ?? "whatsapp-webhook",
    });
  }
}
