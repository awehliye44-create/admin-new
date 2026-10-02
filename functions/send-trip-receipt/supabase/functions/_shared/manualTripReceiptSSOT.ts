/**
 * Manual trip receipt email SSOT.
 * Completing a trip or capturing payment must never email a receipt.
 * Email is sent only after an authenticated customer or admin action.
 * One trip id = one invoice. Never merge stacked trips into one receipt.
 */

export const RECEIPT_EMAIL_SOURCES = ["customer_app", "admin_panel"] as const;
export type ReceiptEmailSource = (typeof RECEIPT_EMAIL_SOURCES)[number];

export const MANUAL_TRIP_RECEIPT_EMAIL_TYPE = "customer_trip_receipt_manual" as const;

/** Second tap of the same address inside this window returns the first result. */
export const RECEIPT_SEND_IDEMPOTENCY_MS = 45_000;

/** A sending row older than this is treated as a crashed claim and may be retried. */
export const RECEIPT_INFLIGHT_STALE_MS = 2 * 60_000;

export type ReceiptEmailBadge = "not_sent" | "sending" | "sent" | "failed";

const EMAIL_RE = /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/i;

export function normalizeReceiptEmail(raw: string | null | undefined): string | null {
  const email = (raw ?? "").trim().toLowerCase();
  if (!email || email.length > 254) return null;
  if (/\s/.test(email)) return null;
  if (!EMAIL_RE.test(email)) return null;
  return email;
}

const FAILED_HOLD = /fail|declin|cancel|void|expired|error/i;

/**
 * A covering card hold is settled enough for a manual receipt while capture
 * is still waiting for the tip window. It is not captured money.
 */
export function coveringAuthorisedHoldPence(
  sessions: Array<{
    status?: string | null;
    provider_state?: string | null;
    authorised_amount_pence?: number | null;
  }>,
  finalFarePence: number,
): number {
  const fare = Math.round(finalFarePence);
  if (fare <= 0) return 0;
  let best = 0;
  for (const session of sessions) {
    const status = `${session.status ?? ""} ${session.provider_state ?? ""}`;
    if (FAILED_HOLD.test(status)) continue;
    const amount = Math.round(session.authorised_amount_pence ?? 0);
    if (amount > best) best = amount;
  }
  return best + 1 >= fare ? best : 0;
}

export function isReceiptEligibleTripStatus(status: string | null | undefined): boolean {
  const normalized = (status ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return normalized === "completed" || normalized === "no_show";
}

/**
 * Invoice column status. Completion and PDF generation are not send evidence.
 * Sent only when a successful email timestamp exists, or the latest send log is sent.
 */
export function resolveReceiptEmailBadge(input: {
  invoice_email_sent_at?: string | null;
  invoice_email_status?: string | null;
  /** Latest invoice_email_outbox status, when the trip columns have not caught up. */
  invoice_email_log_status?: string | null;
  invoice_email_log_sent_at?: string | null;
  requestInProgress?: boolean;
}): ReceiptEmailBadge {
  if (input.requestInProgress) return "sending";
  // The email log is the last attempt when it exists. Trip columns are the fallback.
  // A successful send timestamp still counts if the latest row is only a stale claim.
  const status = (input.invoice_email_log_status ?? input.invoice_email_status ?? "")
    .trim()
    .toLowerCase();
  const sentAt = input.invoice_email_log_sent_at ?? input.invoice_email_sent_at ?? null;
  if (status === "failed") return "failed";
  if (sentAt || status === "sent") return "sent";
  if (status === "sending" || status === "pending") return "sending";
  return "not_sent";
}

export function receiptEmailBadgeLabel(badge: ReceiptEmailBadge): string {
  switch (badge) {
    case "sending":
      return "Sending…";
    case "sent":
      return "Sent";
    case "failed":
      return "Failed";
    default:
      return "Not sent";
  }
}

export type ReceiptSendClaimDecision = "send" | "in_progress" | "already_sent";

/**
 * Rapid double-tap decision. Does not invent a second invoice for a stacked trip.
 * A later explicit send after the idempotency window is a new manual action.
 */
export function receiptSendClaimDecision(args: {
  inflightUpdatedAt?: string | null;
  recentSentAt?: string | null;
  recentSentRecipient?: string | null;
  recipient: string;
  nowMs: number;
}): ReceiptSendClaimDecision {
  if (args.inflightUpdatedAt) {
    const age = args.nowMs - Date.parse(args.inflightUpdatedAt);
    if (Number.isFinite(age) && age >= 0 && age < RECEIPT_INFLIGHT_STALE_MS) {
      return "in_progress";
    }
  }
  const recipient = normalizeReceiptEmail(args.recipient);
  const sentTo = normalizeReceiptEmail(args.recentSentRecipient);
  if (args.recentSentAt && recipient && sentTo === recipient) {
    const age = args.nowMs - Date.parse(args.recentSentAt);
    if (Number.isFinite(age) && age >= 0 && age < RECEIPT_SEND_IDEMPOTENCY_MS) {
      return "already_sent";
    }
  }
  return "send";
}
