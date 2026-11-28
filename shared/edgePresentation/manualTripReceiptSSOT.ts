/** Admin presentation-only helpers; not part of Edge uploads. */
import { ReceiptEmailBadge } from "../../supabase/functions/_shared/manualTripReceiptSSOT.ts";


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

export * from "../../supabase/functions/_shared/manualTripReceiptSSOT.ts";
