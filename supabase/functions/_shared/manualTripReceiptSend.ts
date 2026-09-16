/**
 * Manual trip receipt send.
 * One trip_id = one invoice. Never loads or merges a stacked trip.
 * Callers must already have authenticated the customer or admin.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  MANUAL_TRIP_RECEIPT_EMAIL_TYPE,
  RECEIPT_INFLIGHT_STALE_MS,
  coveringAuthorisedHoldPence,
  isReceiptEligibleTripStatus,
  normalizeReceiptEmail,
  receiptSendClaimDecision,
  type ReceiptEmailSource,
} from "./manualTripReceiptSSOT.ts";
import {
  ensureTripInvoicePdf,
  fetchTrip,
  loadTripInvoicePaymentState,
  sendTripInvoiceEmail,
} from "./tripInvoice.ts";
import { isInvoiceEmailAllowed } from "./tripInvoicePaymentStateSSOT.ts";

const OUTBOX_SELECT =
  "id, trip_id, recipient_email, status, sent_at, updated_at, email_type";

export type ManualTripReceiptResult = {
  ok: boolean;
  status: "sent" | "sending" | "failed";
  idempotent?: boolean;
  error?: string;
  invoice_email_sent_at?: string | null;
  invoice_email_status?: string;
  invoice_email_recipient?: string;
};

async function markOutbox(
  supabase: SupabaseClient,
  outboxId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await supabase.from("invoice_email_outbox").update({
    ...patch,
    updated_at: new Date().toISOString(),
  }).eq("id", outboxId);
}

async function writeAuditColumns(
  supabase: SupabaseClient,
  tripId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase.from("trips").update(patch).eq("id", tripId);
  if (error) {
    console.warn("[MANUAL_RECEIPT] audit_column_write_failed", {
      trip_id: tripId,
      error: error.message,
    });
  }
}

export async function sendManualTripReceipt(
  supabase: SupabaseClient,
  args: {
    tripId: string;
    email: string;
    sentBy: string;
    source: ReceiptEmailSource;
    recipientUserId: string;
  },
): Promise<ManualTripReceiptResult> {
  const email = normalizeReceiptEmail(args.email);
  if (!email) {
    return { ok: false, status: "failed", error: "Enter a valid email address" };
  }
  if (!args.tripId) {
    return { ok: false, status: "failed", error: "Missing trip" };
  }

  // Single trip. Do not follow stacked_trip_id or combine invoices.
  const trip = await fetchTrip(supabase, args.tripId);
  if (!trip) return { ok: false, status: "failed", error: "Trip not found" };

  if (!isReceiptEligibleTripStatus(trip.status)) {
    return { ok: false, status: "failed", error: "Receipt is only available for a completed trip" };
  }

  const paymentState = await loadTripInvoicePaymentState(supabase, trip);
  const capturedEnough = isInvoiceEmailAllowed(paymentState);
  let authorisedHoldPence = 0;
  if (!capturedEnough) {
    const [{ data: sessions }, { data: tripHold }] = await Promise.all([
      supabase
        .from("payment_sessions")
        .select("status, provider_state, authorised_amount_pence")
        .eq("trip_id", trip.id),
      supabase
        .from("trips")
        .select("authorised_amount_pence")
        .eq("id", trip.id)
        .maybeSingle(),
    ]);
    const tripHoldPence = Number(tripHold?.authorised_amount_pence ?? 0);
    authorisedHoldPence = coveringAuthorisedHoldPence([
      ...(sessions ?? []),
      tripHoldPence > 0
        ? { status: "authorised", authorised_amount_pence: tripHoldPence }
        : { status: "missing", authorised_amount_pence: 0 },
    ], paymentState.finalFarePence);
  }
  if (!capturedEnough && authorisedHoldPence <= 0) {
    return {
      ok: false,
      status: "failed",
      error: "Receipt is not available until payment is captured",
    };
  }

  const nowMs = Date.now();
  const { data: inflight } = await supabase
    .from("invoice_email_outbox")
    .select(OUTBOX_SELECT)
    .eq("trip_id", args.tripId)
    .in("status", ["pending", "sending"])
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: recentSent } = await supabase
    .from("invoice_email_outbox")
    .select(OUTBOX_SELECT)
    .eq("trip_id", args.tripId)
    .eq("status", "sent")
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let decision = receiptSendClaimDecision({
    inflightUpdatedAt: (inflight?.updated_at as string | null) ?? null,
    recentSentAt: (recentSent?.sent_at as string | null) ?? null,
    recentSentRecipient: (recentSent?.recipient_email as string | null) ?? null,
    recipient: email,
    nowMs,
  });

  if (decision === "in_progress" && inflight?.id) {
    const age = nowMs - Date.parse(String(inflight.updated_at ?? ""));
    if (Number.isFinite(age) && age >= RECEIPT_INFLIGHT_STALE_MS) {
      await markOutbox(supabase, inflight.id as string, {
        status: "failed",
        error_message: "Send claim expired before the email was sent",
      });
      decision = "send";
    }
  }

  if (decision === "in_progress") {
    return {
      ok: true,
      status: "sending",
      idempotent: true,
      invoice_email_status: "sending",
      invoice_email_recipient: email,
    };
  }

  if (decision === "already_sent") {
    return {
      ok: true,
      status: "sent",
      idempotent: true,
      invoice_email_status: "sent",
      invoice_email_sent_at: (recentSent?.sent_at as string | null) ?? null,
      invoice_email_recipient: email,
    };
  }

  const { data: claimed, error: claimError } = await supabase
    .from("invoice_email_outbox")
    .insert({
      trip_id: args.tripId,
      recipient_user_id: args.recipientUserId,
      recipient_email: email,
      email_type: MANUAL_TRIP_RECEIPT_EMAIL_TYPE,
      status: "sending",
      metadata: {
        source: args.source,
        sent_by: args.sentBy,
        stacked: false,
      },
    })
    .select(OUTBOX_SELECT)
    .maybeSingle();

  if (claimError) {
    if (claimError.code === "23505") {
      return {
        ok: true,
        status: "sending",
        idempotent: true,
        invoice_email_status: "sending",
        invoice_email_recipient: email,
      };
    }
    return { ok: false, status: "failed", error: "Could not send receipt" };
  }

  const outboxId = claimed?.id as string | undefined;
  await writeAuditColumns(supabase, args.tripId, {
    invoice_email_status: "sending",
    invoice_email_error: null,
    invoice_email_recipient: email,
    invoice_email_sent_by: args.sentBy,
    invoice_email_source: args.source,
  });

  try {
    const { trip: withPdf, path } = await ensureTripInvoicePdf(supabase, trip, paymentState, {
      authorisedHoldPence: capturedEnough ? 0 : authorisedHoldPence,
    });
    const emailResult = await sendTripInvoiceEmail(supabase, withPdf, path, paymentState, {
      toEmail: email,
      sentBy: args.sentBy,
      source: args.source,
      authorisedHoldPence: capturedEnough ? 0 : authorisedHoldPence,
    });

    if (!emailResult.ok) {
      if (outboxId) {
        await markOutbox(supabase, outboxId, {
          status: "failed",
          error_message: emailResult.error ?? "Could not send receipt",
        });
      }
      return {
        ok: false,
        status: "failed",
        error: "Could not send receipt",
        invoice_email_status: "failed",
        invoice_email_recipient: email,
      };
    }

    const sentAt = new Date().toISOString();
    if (outboxId) {
      await markOutbox(supabase, outboxId, {
        status: "sent",
        sent_at: sentAt,
        error_message: null,
        pdf_storage_path: path,
      });
    }

    return {
      ok: true,
      status: "sent",
      invoice_email_status: "sent",
      invoice_email_sent_at: sentAt,
      invoice_email_recipient: email,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not send receipt";
    if (outboxId) {
      await markOutbox(supabase, outboxId, { status: "failed", error_message: message });
    }
    await writeAuditColumns(supabase, args.tripId, {
      invoice_email_status: "failed",
      invoice_email_error: message,
      invoice_email_sent: false,
      invoice_email_recipient: email,
      invoice_email_sent_by: args.sentBy,
      invoice_email_source: args.source,
    });
    console.error("[MANUAL_RECEIPT] send_failed", { trip_id: args.tripId, error: message });
    return { ok: false, status: "failed", error: "Could not send receipt" };
  }
}
