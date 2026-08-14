import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";

export const CUSTOMER_TRIP_RECEIPT_EMAIL_TYPE = "customer_trip_receipt" as const;
export const CUSTOMER_TRIP_RECEIPT_ADMIN_RESEND_EMAIL_TYPE =
  "customer_trip_receipt_admin_resend" as const;

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

export function buildSinglePdfAttachment(
  pdfBytes: Uint8Array,
  fileName: string,
): { filename: string; content: string; contentType: string }[] {
  if (!fileName.toLowerCase().endsWith(".pdf")) {
    throw new Error("Invoice email attachment must use a .pdf filename");
  }
  let binary = "";
  for (let i = 0; i < pdfBytes.length; i++) binary += String.fromCharCode(pdfBytes[i]);
  return [{
    filename: fileName,
    content: btoa(binary),
    contentType: "application/pdf",
  }];
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

export async function claimInvoiceEmailOutboxSend(
  supabase: SupabaseClient,
  args: {
    tripId: string;
    recipientUserId: string;
    recipientEmail: string;
    emailType: string;
    pdfStoragePath: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<OutboxClaimResult> {
  const insertPayload = {
    trip_id: args.tripId,
    recipient_user_id: args.recipientUserId,
    recipient_email: args.recipientEmail,
    email_type: args.emailType,
    pdf_storage_path: args.pdfStoragePath,
    status: "pending" as const,
    metadata: args.metadata ?? null,
  };

  const { data: inserted, error: insertError } = await supabase
    .from("invoice_email_outbox")
    .insert(insertPayload)
    .select(OUTBOX_SELECT)
    .maybeSingle();

  if (!insertError && inserted) {
    return tryClaimExistingOutboxRow(supabase, inserted as InvoiceEmailOutboxRow);
  }

  if (!isUniqueViolation(insertError)) {
    throw new Error(insertError?.message ?? "Failed to create invoice email outbox row");
  }

  const { data: existing, error: fetchError } = await supabase
    .from("invoice_email_outbox")
    .select(OUTBOX_SELECT)
    .eq("trip_id", args.tripId)
    .eq("recipient_user_id", args.recipientUserId)
    .eq("email_type", args.emailType)
    .maybeSingle();

  if (fetchError || !existing) {
    throw new Error(fetchError?.message ?? "Outbox row missing after unique conflict");
  }

  return tryClaimExistingOutboxRow(supabase, existing as InvoiceEmailOutboxRow);
}

export async function markInvoiceEmailOutboxSent(
  supabase: SupabaseClient,
  outboxId: string,
  providerMessageId: string | null,
): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("invoice_email_outbox")
    .update({
      status: "sent",
      sent_at: now,
      provider_message_id: providerMessageId,
      error_message: null,
      updated_at: now,
    })
    .eq("id", outboxId);
  if (error) throw new Error(`Failed to mark outbox sent: ${error.message}`);
}

export async function markInvoiceEmailOutboxFailed(
  supabase: SupabaseClient,
  outboxId: string,
  errorMessage: string,
): Promise<void> {
  const { data: row } = await supabase
    .from("invoice_email_outbox")
    .select("retry_count")
    .eq("id", outboxId)
    .maybeSingle();

  const { error } = await supabase
    .from("invoice_email_outbox")
    .update({
      status: "failed",
      error_message: errorMessage,
      retry_count: Number(row?.retry_count ?? 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq("id", outboxId);
  if (error) throw new Error(`Failed to mark outbox failed: ${error.message}`);
}
