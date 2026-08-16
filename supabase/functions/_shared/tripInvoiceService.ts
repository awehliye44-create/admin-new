import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { fetchCompanyBranding, formatCompanyAddress } from "./companyBranding.ts";
import { formatResendFromAddress, sendResendEmail } from "./resendMail.ts";
import {
  buildTripInvoicePayload,
  invoicePdfFileName,
  resolveCustomerEmail,
  resolveCustomerUserId,
} from "./tripInvoiceData.ts";
import { buildTripInvoiceEmailHtml } from "./tripInvoiceHtml.ts";
import { buildTripInvoicePdf } from "./tripInvoicePdf.ts";
import type { TripInvoiceAction, TripInvoiceResponse } from "./tripInvoiceTypes.ts";
import {
  canAutoSendCustomerInvoice,
  isPaymentFinalisedForInvoice,
  isTripCompletedForCustomerInvoice,
} from "./tripInvoiceEligibility.ts";
import {
  buildSinglePdfAttachment,
  claimInvoiceEmailOutboxSend,
  CUSTOMER_TRIP_RECEIPT_ADMIN_RESEND_EMAIL_TYPE,
  CUSTOMER_TRIP_RECEIPT_EMAIL_TYPE,
  hasAutoCustomerReceiptBeenSent,
  markInvoiceEmailOutboxFailed,
  markInvoiceEmailOutboxSent,
} from "./invoiceEmailOutbox.ts";

const BUCKET = "trip-invoices";

const TRIP_SELECT = `
  id, trip_code, status, financial_outcome, payment_method, payment_status, provider_order_id, payment_intent_id,
  tip_window_closed_at, tip_window_expires_at,
  passenger_id, passenger_name, passenger_phone,
  pickup_address, dropoff_address, started_at, completed_at, created_at,
  driver_id, fare, estimated_fare, final_fare_pence, final_customer_fare_pence,
  capture_amount_pence, gross_fare_pence, locked_base_fare_pence, offer_discount_pence,
  promotion_discount_pence, discount_pence, customer_modification_charge_pence,
  pickup_waiting_charge_pence, stop_waiting_charge_pence, stop_charge_total_pence,
  tip_pence, tip_amount_pence, airport_charge_pence, other_pass_through_charges_pence,
  refund_amount_pence, refunded_at, fare_snapshot_json,
  fare_breakdown, total_waiting_charge_pence, waiting_charge_pence, extras_pence,
  invoice_no, invoice_pdf_url, invoice_pdf_path, invoice_generated_at,
  invoice_email_sent, invoice_email_sent_at, invoice_email_status, invoice_email_error,
  invoice_total_paid_pence, invoice_regenerated_at, invoice_pdf_error
`;

function log(step: string, payload?: Record<string, unknown>) {
  console.log("[TRIP_INVOICE]", JSON.stringify({ step, ...payload }));
}

async function logEvent(
  supabase: SupabaseClient,
  tripId: string,
  eventType: string,
  status: string,
  message?: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase.from("trip_invoice_events").insert({
    trip_id: tripId,
    event_type: eventType,
    status,
    message: message ?? null,
    metadata: metadata ?? null,
  });
  if (error) {
    console.warn("[TRIP_INVOICE] log_event_failed", error.message);
  }
}

async function logEvent(
  supabase: SupabaseClient,
  tripId: string,
  eventType: string,
  status: string,
  message?: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase.from("trip_invoice_events").insert({
    trip_id: tripId,
    event_type: eventType,
    status,
    message: message ?? null,
    metadata: metadata ?? null,
  });
  if (error) {
    console.warn("[TRIP_INVOICE] log_event_failed", error.message);
  }
}

async function syncTripInvoiceEmailFlags(
  supabase: SupabaseClient,
  tripId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await supabase.from("trips").update(patch).eq("id", tripId);
}

function moneyDisplay(pence: number, currency: string): string {
  const sym = currency === "GBP" ? "£" : "$";
  return `${sym}${(pence / 100).toFixed(2)}`;
}

function normalizeAction(action: TripInvoiceAction): TripInvoiceAction {
  if (action === "resend") return "resend_email";
  return action;
}

function isTripCompleted(trip: Record<string, unknown>): boolean {
  return isTripCompletedForCustomerInvoice(trip);
}

function isTripReadyForInvoice(trip: Record<string, unknown>, adminBypass = false): boolean {
  if (!isTripCompleted(trip)) return false;
  if (adminBypass) return true;
  return isPaymentFinalisedForInvoice(trip);
}

function isAutoInvoiceAction(action: TripInvoiceAction): boolean {
  return action === "auto" || action === "generate";
}

function storagePathForInvoice(invoiceNo: string): string {
  return `invoices/customer/${invoiceNo}.pdf`;
}

function toResponse(
  trip: Record<string, unknown>,
  extra: Partial<TripInvoiceResponse> = {},
): TripInvoiceResponse {
  return {
    success: extra.success ?? extra.ok ?? true,
    ok: extra.ok ?? extra.success ?? true,
    trip_id: trip.id as string,
    bookingId: trip.id as string,
    invoice_no: (extra.invoice_no ?? trip.invoice_no) as string | undefined,
    invoiceNo: (extra.invoice_no ?? trip.invoice_no) as string | undefined,
    invoice_pdf_url: (extra.invoice_pdf_url ?? trip.invoice_pdf_url) as string | undefined,
    pdfUrl: (extra.pdf_url ?? extra.invoice_pdf_url ?? trip.invoice_pdf_url) as string | undefined,
    html_url: extra.html_url,
    htmlUrl: extra.html_url,
    invoice_generated_at: (extra.invoice_generated_at ?? trip.invoice_generated_at) as string | undefined,
    invoiceGeneratedAt: (extra.invoice_generated_at ?? trip.invoice_generated_at) as string | undefined,
    invoice_email_status: (extra.invoice_email_status ?? trip.invoice_email_status) as string | undefined,
    invoiceEmailStatus: (extra.invoice_email_status ?? trip.invoice_email_status) as string | undefined,
    invoice_email_sent_at: (extra.invoice_email_sent_at ?? trip.invoice_email_sent_at) as string | undefined,
    invoiceEmailSentAt: (extra.invoice_email_sent_at ?? trip.invoice_email_sent_at) as string | undefined,
    payment_method: (trip.payment_method as string) ?? undefined,
    paymentMethod: (trip.payment_method as string) ?? undefined,
    total_paid_pence: (extra.total_paid_pence ?? trip.invoice_total_paid_pence) as number | undefined,
    totalPaid: extra.total_paid_pence ?? trip.invoice_total_paid_pence as number | undefined,
    message: extra.message,
    error: extra.error,
    stage: extra.stage,
  };
}

async function allocateInvoiceNo(
  supabase: SupabaseClient,
  existing: string | null,
): Promise<string> {
  if (existing) return existing;
  const { data, error } = await supabase.rpc("next_trip_invoice_number");
  if (error || !data) throw new Error(error?.message ?? "Failed to allocate invoice number");
  return data as string;
}

async function loadInvoiceTemplate(supabase: SupabaseClient) {
  const { data } = await supabase
    .from("invoice_templates")
    .select("*")
    .eq("is_default", true)
    .maybeSingle();
  return data;
}

async function validateTripData(
  supabase: SupabaseClient,
  trip: Record<string, unknown>,
  adminBypass: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!trip.id) return { ok: false, error: "Booking not found" };
  if (!isTripCompleted(trip)) {
    return { ok: false, error: "Booking status must be Completed" };
  }
  if (!trip.trip_code) {
    log("missing_trip_code", { trip_id: trip.id });
  }
  if (!trip.payment_method) {
    log("missing_payment_method", { trip_id: trip.id });
  }

  const companyBranding = await fetchCompanyBranding(supabase);
  if (!companyBranding.company.name && !companyBranding.company.legalName) {
    return { ok: false, error: "Company information not configured in General & Branding" };
  }

  await loadInvoiceTemplate(supabase);

  if (!isTripReadyForInvoice(trip, adminBypass)) {
    return {
      ok: false,
      error: "Trip payment is not finalised yet. Admin regenerate may still be attempted after payment completes.",
    };
  }

  const totalPaid = Number(trip.invoice_total_paid_pence ?? trip.capture_amount_pence ?? trip.final_fare_pence ?? 0);
  if (!totalPaid && !trip.fare && !trip.estimated_fare) {
    log("missing_total_paid", { trip_id: trip.id });
  }

  const email = await resolveCustomerEmail(supabase, (trip.passenger_id as string) ?? null);
  if (!trip.passenger_name && !email) {
    log("missing_customer", { trip_id: trip.id });
  }

  return { ok: true };
}

async function ensureBucket(supabase: SupabaseClient): Promise<void> {
  const { data: buckets } = await supabase.storage.listBuckets();
  const exists = (buckets ?? []).some((b) => b.name === BUCKET);
  if (!exists) {
    const { error } = await supabase.storage.createBucket(BUCKET, { public: false });
    if (error && !error.message?.includes("already exists")) {
      throw new Error(`Invoice storage bucket missing: ${error.message}`);
    }
  }
}

async function generateInvoicePdf(
  supabase: SupabaseClient,
  trip: Record<string, unknown>,
  forceRegenerate: boolean,
): Promise<Record<string, unknown>> {
  await ensureBucket(supabase);

  const invoiceNo = await allocateInvoiceNo(supabase, (trip.invoice_no as string) ?? null);
  log("invoice_number", {
    trip_id: trip.id,
    invoice_no: invoiceNo,
    passenger_id: trip.passenger_id ?? null,
  });

  if (trip.invoice_no && trip.invoice_no !== invoiceNo) {
    throw new Error(`Invoice number mismatch for trip ${trip.id}`);
  }

  const payload = await buildTripInvoicePayload(supabase, trip, invoiceNo);
  const template = await loadInvoiceTemplate(supabase);
  if (template?.logo_url) payload.branding.logoUrl = template.logo_url as string;

  const pdfBytes = await buildTripInvoicePdf(payload);
  if (
    pdfBytes.length < 5
    || pdfBytes[0] !== 0x25
    || pdfBytes[1] !== 0x50
    || pdfBytes[2] !== 0x44
    || pdfBytes[3] !== 0x46
  ) {
    throw new Error("Invoice generator did not produce a valid PDF document");
  }

  const storagePath = storagePathForInvoice(invoiceNo);

  const { error: uploadErr } = await supabase.storage.from(BUCKET).upload(storagePath, pdfBytes, {
    contentType: "application/pdf",
    upsert: true,
  });
  if (uploadErr) throw new Error(`PDF upload failed: ${uploadErr.message}`);

  const { data: signed, error: signErr } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, 60 * 60 * 24 * 365);

  if (signErr || !signed?.signedUrl) {
    throw new Error(signErr?.message ?? "Failed to create signed URL");
  }

  log("pdf_generated", { trip_id: trip.id, invoice_no: invoiceNo, storage_path: storagePath });

  const now = new Date().toISOString();
  const updatePayload: Record<string, unknown> = {
    invoice_no: invoiceNo,
    invoice_pdf_path: storagePath,
    invoice_pdf_url: signed.signedUrl,
    invoice_generated_at: now,
    invoice_pdf_error: null,
    invoice_total_paid_pence: payload.totalPaidPence,
    ...(forceRegenerate ? { invoice_regenerated_at: now } : {}),
  };

  await supabase.from("trips").update(updatePayload).eq("id", trip.id);
  await logEvent(supabase, trip.id as string, "pdf_generated", "success", storagePath, { invoice_no: invoiceNo });

  return { ...trip, ...updatePayload };
}

async function getSignedUrls(
  supabase: SupabaseClient,
  storagePath: string,
  options: { invoiceNo?: string; mode?: "view" | "download" } = {},
): Promise<{ pdf_url?: string }> {
  const invoiceNo = options.invoiceNo ?? storagePath.replace(/.*\//, "").replace(/\.pdf$/, "");
  const signedOptions = options.mode === "download"
    ? { download: `ONECAB_Invoice_${invoiceNo}.pdf` }
    : undefined;

  const { data: pdfSigned, error: pdfErr } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, 60 * 60, signedOptions);

  if (pdfErr) {
    log("signed_url_failed", { storagePath, error: pdfErr.message });
  }

  return { pdf_url: pdfSigned?.signedUrl };
}

async function clearStalePdfError(
  supabase: SupabaseClient,
  trip: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!trip.invoice_pdf_error) return trip;
  if (!trip.invoice_pdf_path && !trip.invoice_generated_at && !trip.invoice_pdf_url) return trip;

  const { data } = await supabase
    .from("trips")
    .update({ invoice_pdf_error: null })
    .eq("id", trip.id as string)
    .select(TRIP_SELECT)
    .single();

  return data ?? { ...trip, invoice_pdf_error: null };
}

async function ensurePdf(
  supabase: SupabaseClient,
  trip: Record<string, unknown>,
  forceRegenerate: boolean,
): Promise<Record<string, unknown>> {
  if (!forceRegenerate && trip.invoice_pdf_path && trip.invoice_generated_at) {
    return clearStalePdfError(supabase, trip);
  }
  return generateInvoicePdf(supabase, trip, forceRegenerate);
}

async function sendInvoiceEmail(
  supabase: SupabaseClient,
  trip: Record<string, unknown>,
  forceResend: boolean,
): Promise<TripInvoiceResponse> {
  const tripId = trip.id as string;

  try {
    const recipientUserId = await resolveCustomerUserId(
      supabase,
      (trip.passenger_id as string) ?? null,
    );
    if (!recipientUserId) {
      await syncTripInvoiceEmailFlags(supabase, tripId, {
        invoice_email_sent: false,
        invoice_email_status: "failed",
        invoice_email_error: "Customer account could not be resolved",
      });
      return toResponse(trip, {
        success: false,
        ok: false,
        error: "Customer account could not be resolved",
        stage: "email_sending",
        invoice_email_status: "failed",
      });
    }

    if (!forceResend) {
      const alreadySent = trip.invoice_email_sent
        || await hasAutoCustomerReceiptBeenSent(supabase, tripId, recipientUserId);
      if (alreadySent) {
        return toResponse(trip, {
          success: true,
          message: "Invoice email already sent",
          invoice_email_status: "sent",
        });
      }
    }

    const email = await resolveCustomerEmail(supabase, (trip.passenger_id as string) ?? null);
    if (!email) {
      await syncTripInvoiceEmailFlags(supabase, tripId, {
        invoice_email_sent: false,
        invoice_email_status: "failed",
        invoice_email_error: "Customer account email could not be resolved",
      });
      return toResponse(trip, {
        success: false,
        ok: false,
        error: "Customer account email could not be resolved",
        stage: "email_sending",
        invoice_email_status: "failed",
      });
    }

    const storagePath = trip.invoice_pdf_path as string;
    if (!storagePath) {
      return toResponse(trip, {
        success: false,
        ok: false,
        error: "Invoice PDF not generated",
        stage: "email_sending",
      });
    }

    if (!storagePath.endsWith(".pdf")) {
      return toResponse(trip, {
        success: false,
        ok: false,
        error: "Invoice storage path must reference a PDF file",
        stage: "email_sending",
      });
    }

    const emailType = forceResend
      ? CUSTOMER_TRIP_RECEIPT_ADMIN_RESEND_EMAIL_TYPE
      : CUSTOMER_TRIP_RECEIPT_EMAIL_TYPE;

    let outboxClaim;
    if (forceResend) {
      const { data: inserted, error: insertError } = await supabase
        .from("invoice_email_outbox")
        .insert({
          trip_id: tripId,
          recipient_user_id: recipientUserId,
          recipient_email: email,
          email_type: emailType,
          pdf_storage_path: storagePath,
          status: "sending",
          metadata: { admin_resend: true },
        })
        .select("id, trip_id, recipient_user_id, recipient_email, email_type, pdf_storage_path, status, sent_at, provider_message_id, retry_count, error_message, metadata")
        .single();
      if (insertError || !inserted) {
        throw new Error(insertError?.message ?? "Failed to create admin resend outbox row");
      }
      outboxClaim = { ok: true as const, reason: "claimed" as const, row: inserted };
    } else {
      outboxClaim = await claimInvoiceEmailOutboxSend(supabase, {
        tripId,
        recipientUserId,
        recipientEmail: email,
        emailType,
        pdfStoragePath: storagePath,
      });
    }

    if (!outboxClaim.ok) {
      const message = outboxClaim.reason === "already_sent"
        ? "Invoice email already sent"
        : "Invoice email send already in progress";
      return toResponse(outboxClaim.row ?? trip, {
        success: true,
        message,
        invoice_email_status: outboxClaim.reason === "already_sent" ? "sent" : "sending",
      });
    }

    const outboxRow = outboxClaim.row;
    await syncTripInvoiceEmailFlags(supabase, tripId, {
      invoice_email_status: "sending",
      invoice_email_error: null,
    });

    const { data: fileData, error: dlErr } = await supabase.storage.from(BUCKET).download(storagePath);
    if (dlErr || !fileData) {
      const msg = dlErr?.message ?? "Failed to download invoice PDF";
      await markInvoiceEmailOutboxFailed(supabase, outboxRow.id, msg);
      await syncTripInvoiceEmailFlags(supabase, tripId, {
        invoice_email_sent: false,
        invoice_email_status: "failed",
        invoice_email_error: msg,
      });
      return toResponse(trip, {
        success: false,
        ok: false,
        error: msg,
        stage: "email_sending",
        invoice_email_status: "failed",
      });
    }

    const pdfBytes = new Uint8Array(await fileData.arrayBuffer());
    if (
      pdfBytes.length < 5
      || pdfBytes[0] !== 0x25
      || pdfBytes[1] !== 0x50
      || pdfBytes[2] !== 0x44
      || pdfBytes[3] !== 0x46
    ) {
      const msg = "Stored invoice file is not a valid PDF";
      await markInvoiceEmailOutboxFailed(supabase, outboxRow.id, msg);
      await syncTripInvoiceEmailFlags(supabase, tripId, {
        invoice_email_sent: false,
        invoice_email_status: "failed",
        invoice_email_error: msg,
      });
      return toResponse(trip, {
        success: false,
        ok: false,
        error: msg,
        stage: "email_sending",
        invoice_email_status: "failed",
      });
    }

    const invoiceNo = (trip.invoice_no as string) ?? "INV-UNKNOWN";
    const tripCode = (trip.trip_code as string) ?? tripId;
    const payload = await buildTripInvoicePayload(supabase, trip, invoiceNo);
    const totalPaid = moneyDisplay(payload.totalPaidPence, payload.currency);
    const companyBranding = await fetchCompanyBranding(supabase);
    const fromAddress = formatResendFromAddress(
      companyBranding.company.name || companyBranding.company.legalName,
      companyBranding.company.email,
    );

    const { html, text } = buildTripInvoiceEmailHtml({
      customerName: payload.customerName,
      tripId: tripCode,
      invoiceNo,
      paymentMethod: payload.paymentMethod,
      totalPaid,
      tripDateTime: payload.dropoffAt || payload.pickupAt || payload.invoiceDate,
      pickupAddress: payload.pickupAddress,
      dropoffAddress: payload.dropoffAddress,
      companyName: companyBranding.company.name || companyBranding.company.legalName || "ONECAB",
      companyAddress: formatCompanyAddress(companyBranding.company) || companyBranding.company.address,
      companyPhone: companyBranding.company.phone,
      companyEmail: companyBranding.company.email,
      companyWebsite: companyBranding.company.website,
      logoUrl: companyBranding.branding.logoUrl || undefined,
      tagline: companyBranding.branding.tagline || undefined,
    });

    const fileName = invoicePdfFileName(invoiceNo, tripCode);
    const attachments = buildSinglePdfAttachment(pdfBytes, fileName);

    log("email_sending_started", {
      trip_id: tripId,
      to: email,
      invoice_no: invoiceNo,
      attachment: fileName,
      outbox_id: outboxRow.id,
      email_type: emailType,
      attachment_count: attachments.length,
    });

    const sendResult = await sendResendEmail({
      to: email,
      subject: `Your ONECAB Trip Receipt — ${invoiceNo}`,
      html,
      text,
      from: fromAddress,
      replyTo: companyBranding.company.email || undefined,
      attachments,
      tag: "trip_invoice",
    });

    const now = new Date().toISOString();
    if (!sendResult.ok) {
      log("email_failed", { trip_id: tripId, error: sendResult.message, outbox_id: outboxRow.id });
      await markInvoiceEmailOutboxFailed(supabase, outboxRow.id, sendResult.message);
      await syncTripInvoiceEmailFlags(supabase, tripId, {
        invoice_email_sent: false,
        invoice_email_status: "failed",
        invoice_email_error: sendResult.message,
      });
      await logEvent(supabase, tripId, "email_sent", "failed", sendResult.message, {
        outbox_id: outboxRow.id,
        email_type: emailType,
      });
      return toResponse(trip, {
        success: false,
        ok: false,
        error: sendResult.message,
        stage: "email_sending",
        invoice_email_status: "failed",
      });
    }

    await markInvoiceEmailOutboxSent(supabase, outboxRow.id, sendResult.id ?? null);
    log("email_sent", {
      trip_id: tripId,
      invoice_no: invoiceNo,
      to: email,
      outbox_id: outboxRow.id,
      provider_message_id: sendResult.id ?? null,
    });

    await syncTripInvoiceEmailFlags(supabase, tripId, {
      invoice_email_sent: true,
      invoice_email_sent_at: now,
      invoice_email_status: "sent",
      invoice_email_error: null,
      invoice_pdf_error: null,
    });
    await logEvent(supabase, tripId, "email_sent", "success", `Sent to ${email}`, {
      outbox_id: outboxRow.id,
      provider_message_id: sendResult.id ?? null,
      email_type: emailType,
      attachment_count: 1,
    });

    const { data: refreshed } = await supabase.from("trips").select(TRIP_SELECT).eq("id", tripId).single();
    return toResponse(refreshed ?? trip, {
      success: true,
      message: forceResend ? "Invoice email resent" : "Invoice email sent",
      invoice_email_sent_at: now,
      invoice_email_status: "sent",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log("email_unexpected_error", { trip_id: tripId, error: message });
    await syncTripInvoiceEmailFlags(supabase, tripId, {
      invoice_email_status: "failed",
      invoice_email_error: message,
    });
    await logEvent(supabase, tripId, "email_sent", "failed", message);
    return toResponse(trip, {
      success: false,
      ok: false,
      error: message,
      stage: "email_sending",
      invoice_email_status: "failed",
    });
  }
}

export async function handleTripInvoiceAction(
  supabase: SupabaseClient,
  tripId: string,
  rawAction: TripInvoiceAction = "generate",
): Promise<TripInvoiceResponse> {
  const action = normalizeAction(rawAction);
  log("received", { trip_id: tripId, action: rawAction, normalized: action });

  const { data: trip, error: tripErr } = await supabase
    .from("trips")
    .select(TRIP_SELECT)
    .eq("id", tripId)
    .single();

  if (tripErr || !trip) {
    log("booking_not_found", { trip_id: tripId, error: tripErr?.message });
    return { success: false, ok: false, error: "Booking not found", trip_id: tripId, bookingId: tripId };
  }

  log("booking_found", { trip_id: tripId, status: trip.status, invoice_no: trip.invoice_no });

  if (isAutoInvoiceAction(action)) {
    const autoGate = canAutoSendCustomerInvoice(trip);
    if (!autoGate.ok) {
      log("auto_send_blocked", { trip_id: tripId, reason: autoGate.reason, status: trip.status });
      return {
        success: true,
        ok: true,
        trip_id: tripId,
        bookingId: tripId,
        message: `Invoice deferred (${autoGate.reason ?? "not_eligible"})`,
      };
    }
  }

  // Admin/manual actions may bypass payment wait; auto never does.
  const adminBypass = ["download", "view", "regenerate", "resend_email", "generate_only"].includes(action);
  const validation = await validateTripData(supabase, trip, adminBypass);
  if (!validation.ok) {
    if (action === "download" || action === "view" || action === "regenerate") {
      if (!isTripCompleted(trip)) {
        return { success: false, ok: false, error: validation.error, trip_id: tripId, bookingId: tripId };
      }
    } else {
      return { success: false, ok: false, error: validation.error, trip_id: tripId, bookingId: tripId };
    }
  }

  try {
    if (action === "download" || action === "view") {
      const updated = await ensurePdf(supabase, trip, false);
      const storagePath = updated.invoice_pdf_path as string;
      if (!storagePath) {
        return { success: false, ok: false, error: "Failed to generate invoice PDF", trip_id: tripId };
      }
      const urls = await getSignedUrls(supabase, storagePath, {
        invoiceNo: updated.invoice_no as string,
        mode: action === "download" ? "download" : "view",
      });
      const pdfUrl = urls.pdf_url ?? (updated.invoice_pdf_url as string);
      if (!pdfUrl) {
        return {
          success: false,
          ok: false,
          error: "Invoice PDF URL could not be created",
          trip_id: tripId,
          stage: "pdf_generation",
        };
      }
      return toResponse(updated, {
        success: true,
        pdf_url: pdfUrl,
        pdfUrl,
        message: action === "download" ? "Invoice PDF ready" : "Invoice ready to view",
      });
    }

    if (action === "regenerate") {
      const updated = await ensurePdf(supabase, trip, true);
      const urls = await getSignedUrls(supabase, updated.invoice_pdf_path as string, {
        invoiceNo: updated.invoice_no as string,
        mode: "view",
      });
      return toResponse(updated, {
        success: true,
        pdf_url: urls.pdf_url ?? updated.invoice_pdf_url as string,
        pdfUrl: urls.pdf_url ?? updated.invoice_pdf_url as string,
        message: "Invoice PDF regenerated",
      });
    }

    if (action === "resend_email") {
      const updated = await ensurePdf(supabase, trip, false);
      return sendInvoiceEmail(supabase, updated, true);
    }

    if (action === "generate_only") {
      const updated = await ensurePdf(supabase, trip, false);
      const urls = await getSignedUrls(supabase, updated.invoice_pdf_path as string, {
        invoiceNo: updated.invoice_no as string,
        mode: "view",
      });
      return toResponse(updated, {
        success: true,
        pdf_url: urls.pdf_url,
        pdfUrl: urls.pdf_url,
        message: "Invoice PDF generated",
      });
    }

    // auto / generate (default): PDF + email if not sent
    const updated = await ensurePdf(supabase, trip, false);
    const recipientUserId = await resolveCustomerUserId(
      supabase,
      (updated.passenger_id as string) ?? null,
    );
    const alreadySent = Boolean(updated.invoice_email_sent)
      || (recipientUserId
        && await hasAutoCustomerReceiptBeenSent(supabase, tripId, recipientUserId));
    if (!alreadySent) {
      return sendInvoiceEmail(supabase, updated, false);
    }
    const urls = await getSignedUrls(supabase, updated.invoice_pdf_path as string, {
      invoiceNo: updated.invoice_no as string,
      mode: "view",
    });
    return toResponse(updated, {
      success: true,
      pdf_url: urls.pdf_url,
      pdfUrl: urls.pdf_url,
      message: "Invoice already generated",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isEmailAction = action === "resend_email" || action === "generate" || action === "auto";
    const hasPdf = Boolean(trip.invoice_pdf_path || trip.invoice_pdf_url);
    const stage = isEmailAction && hasPdf ? "email_sending" : "pdf_generation";

    log("error", { trip_id: tripId, action, stage, error: message, hasPdf });

    if (stage === "email_sending") {
      await supabase.from("trips").update({
        invoice_email_status: "failed",
        invoice_email_error: message,
      }).eq("id", tripId);
    } else {
      await supabase.from("trips").update({ invoice_pdf_error: message }).eq("id", tripId);
    }

    await logEvent(supabase, tripId, "action_failed", "failed", message, { action, stage });
    return {
      success: false,
      ok: false,
      error: message,
      stage,
      trip_id: tripId,
      bookingId: tripId,
      invoice_pdf_url: trip.invoice_pdf_url as string | undefined,
      pdfUrl: trip.invoice_pdf_url as string | undefined,
    };
  }
}

// Legacy exports
export async function processTripInvoice(
  supabase: SupabaseClient,
  tripId: string,
  action: TripInvoiceAction = "auto",
): Promise<TripInvoiceResponse> {
  return handleTripInvoiceAction(supabase, tripId, action);
}

export async function getInvoiceSignedUrls(
  supabase: SupabaseClient,
  tripId: string,
): Promise<TripInvoiceResponse> {
  const { data: trip } = await supabase.from("trips").select(TRIP_SELECT).eq("id", tripId).single();
  if (!trip) return { success: false, ok: false, error: "Trip not found" };

  if (!trip.invoice_pdf_path) {
    return handleTripInvoiceAction(supabase, tripId, "download");
  }

  const urls = await getSignedUrls(supabase, trip.invoice_pdf_path, {
    invoiceNo: trip.invoice_no as string,
    mode: "view",
  });
  return toResponse(trip, { success: true, pdf_url: urls.pdf_url, pdfUrl: urls.pdf_url });
}
