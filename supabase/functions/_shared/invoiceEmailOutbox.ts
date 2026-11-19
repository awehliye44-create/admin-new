import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";

export const CUSTOMER_TRIP_RECEIPT_EMAIL_TYPE = "customer_trip_receipt" as const;
export type InvoiceEmailOutboxStatus = "pending" | "sending" | "sent" | "failed";

export type InvoiceEmailOutboxRow = {
  id: string;
  trip_id: string;
  recipient_user_id: string;
  recipient_email: string;
  email_type: string;
  pdf_storage_path: string | null;
  status: InvoiceEmailOutboxStatus;
  sent_at: string | null;
  provider_message_id: string | null;
  retry_count: number;
  error_message: string | null;
  metadata: Record<string, unknown> | null;
};

export type OutboxClaimResult =
  | { ok: true; row: InvoiceEmailOutboxRow; reason: "claimed" }
  | { ok: false; reason: "already_sent"; row?: InvoiceEmailOutboxRow }
  | { ok: false; reason: "in_progress"; row?: InvoiceEmailOutboxRow }
  | { ok: false; reason: "claim_lost"; row?: InvoiceEmailOutboxRow };

const OUTBOX_SELECT =
  "id, trip_id, recipient_user_id, recipient_email, email_type, pdf_storage_path, status, sent_at, provider_message_id, retry_count, error_message, metadata";

function isUniqueViolation(error: { code?: string } | null): boolean {
  return error?.code === "23505";
}

export async function fetchAutoCustomerReceiptOutbox(
  supabase: SupabaseClient,
  tripId: string,
  recipientUserId: string,
): Promise<InvoiceEmailOutboxRow | null> {
  const { data } = await supabase
    .from("invoice_email_outbox")
    .select(OUTBOX_SELECT)
    .eq("trip_id", tripId)
    .eq("recipient_user_id", recipientUserId)
    .eq("email_type", CUSTOMER_TRIP_RECEIPT_EMAIL_TYPE)
    .maybeSingle();
  return (data as InvoiceEmailOutboxRow | null) ?? null;
}

export async function hasAutoCustomerReceiptBeenSent(
  supabase: SupabaseClient,
  tripId: string,
  recipientUserId: string,
): Promise<boolean> {
  const row = await fetchAutoCustomerReceiptOutbox(supabase, tripId, recipientUserId);
  return Boolean(row?.sent_at) || row?.status === "sent";
}

async function tryClaimExistingOutboxRow(
  supabase: SupabaseClient,
  row: InvoiceEmailOutboxRow,
): Promise<OutboxClaimResult> {
  if (row.sent_at || row.status === "sent") {
    return { ok: false, reason: "already_sent", row };
  }
  if (row.status === "sending") {
    return { ok: false, reason: "in_progress", row };
  }

  const { data: claimed, error } = await supabase
    .from("invoice_email_outbox")
    .update({
      status: "sending",
      error_message: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id)
    .is("sent_at", null)
    .in("status", ["pending", "failed"])
    .select(OUTBOX_SELECT)
    .maybeSingle();

  if (error) {
    throw new Error(`Outbox send claim failed: ${error.message}`);
  }
  if (!claimed) {
    const refreshed = await supabase
      .from("invoice_email_outbox")
      .select(OUTBOX_SELECT)
      .eq("id", row.id)
      .maybeSingle();
    const latest = refreshed.data as InvoiceEmailOutboxRow | null;
    if (latest?.sent_at || latest?.status === "sent") {
      return { ok: false, reason: "already_sent", row: latest ?? undefined };
    }
    return { ok: false, reason: "in_progress", row: latest ?? undefined };
  }

  return { ok: true, row: claimed as InvoiceEmailOutboxRow, reason: "claimed" };
}

