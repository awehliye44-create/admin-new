/**
 * Customer trip invoice SSOT.
 * Generates the invoice number, PDF, storage object, signed URL and customer email
 * for a completed trip. Writer of trips.invoice_* columns.
 */
import { PDFDocument, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { fetchCompanyBranding, formatCompanyAddress } from "./companyBranding.ts";
import { sendResendEmail } from "./resendMail.ts";

const BUCKET = "trip-invoices";
const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 7;

export interface TripInvoiceRow {
  id: string;
  trip_number: string | null;
  trip_code: string | null;
  passenger_id: string | null;
  passenger_name: string | null;
  status: string;
  payment_method: string | null;
  currency_code: string | null;
  currency: string | null;
  completed_at: string | null;
  created_at: string;
  pickup_address: string | null;
  dropoff_address: string | null;
  base_fare_pence: number | null;
  gross_fare_pence: number | null;
  final_fare_pence: number | null;
  final_customer_fare_pence: number | null;
  capture_amount_pence: number | null;
  extras_pence: number | null;
  tip_pence: number | null;
  discount_pence: number | null;
  offer_discount_pence: number | null;
  total_waiting_charge_pence: number | null;
  airport_charge_pence: number | null;
  invoice_no: string | null;
  invoice_pdf_path: string | null;
  invoice_pdf_url: string | null;
  invoice_generated_at: string | null;
  invoice_email_sent: boolean | null;
  invoice_email_status: string | null;
  invoice_email_sent_at: string | null;
  invoice_total_paid_pence: number | null;
}

const TRIP_COLUMNS =
  "id, trip_number, trip_code, passenger_id, passenger_name, status, payment_method, currency_code, currency, completed_at, created_at, pickup_address, dropoff_address, base_fare_pence, gross_fare_pence, final_fare_pence, final_customer_fare_pence, capture_amount_pence, extras_pence, tip_pence, discount_pence, offer_discount_pence, total_waiting_charge_pence, airport_charge_pence, invoice_no, invoice_pdf_path, invoice_pdf_url, invoice_generated_at, invoice_email_sent, invoice_email_status, invoice_email_sent_at, invoice_total_paid_pence";

export function currencySymbol(code: string): string {
  if (code === "GBP") return "£";
  if (code === "USD") return "$";
  if (code === "EUR") return "€";
  return `${code} `;
}

export function money(pence: number, code: string): string {
  return `${currencySymbol(code)}${(Math.abs(pence) / 100).toFixed(2)}`;
}

/** Settlement total actually paid by the customer. */
export function getTripSettlementFarePence(trip: TripInvoiceRow): number {
  return (
    trip.invoice_total_paid_pence ??
    trip.capture_amount_pence ??
    trip.final_customer_fare_pence ??
    trip.final_fare_pence ??
    trip.gross_fare_pence ??
    0
  );
}

export function tripDisplayId(trip: TripInvoiceRow): string {
  return trip.trip_number || trip.trip_code || trip.id.slice(0, 8).toUpperCase();
}

export async function fetchTrip(
  supabase: SupabaseClient,
  tripId: string,
): Promise<TripInvoiceRow | null> {
  const { data, error } = await supabase
    .from("trips")
    .select(TRIP_COLUMNS)
    .eq("id", tripId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as TripInvoiceRow | null) ?? null;
}

async function logEvent(
  supabase: SupabaseClient,
  tripId: string,
  eventType: string,
  status: string,
  message?: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await supabase.from("trip_invoice_events").insert({
    trip_id: tripId,
    event_type: eventType,
    status,
    message: message ?? null,
    metadata: metadata ?? null,
  });
}

async function resolveCustomerEmail(
  supabase: SupabaseClient,
  passengerId: string | null,
): Promise<string | null> {
  if (!passengerId) return null;
  const { data, error } = await supabase.auth.admin.getUserById(passengerId);
  if (error) {
    console.warn("[TRIP_INVOICE] customer_email_lookup_failed", error.message);
    return null;
  }
  const email = data?.user?.email?.trim();
  return email && email.includes("@") ? email : null;
}

interface InvoiceLine {
  label: string;
  amountPence: number;
  isDeduction?: boolean;
}

function buildLines(trip: TripInvoiceRow): InvoiceLine[] {
  const total = getTripSettlementFarePence(trip);
  const lines: InvoiceLine[] = [];
  const base = trip.base_fare_pence ?? null;
  const waiting = trip.total_waiting_charge_pence ?? 0;
  const extras = trip.extras_pence ?? 0;
  const airport = trip.airport_charge_pence ?? 0;
  const tip = trip.tip_pence ?? 0;
  const discount = (trip.discount_pence ?? 0) + (trip.offer_discount_pence ?? 0);

  if (base && base > 0) {
    lines.push({ label: "Trip fare", amountPence: base });
  } else {
    const derived = total - waiting - extras - airport - tip + discount;
    lines.push({ label: "Trip fare", amountPence: Math.max(derived, 0) });
  }
  if (waiting > 0) lines.push({ label: "Waiting time", amountPence: waiting });
  if (airport > 0) lines.push({ label: "Airport charge", amountPence: airport });
  if (extras > 0) lines.push({ label: "Extra charges", amountPence: extras });
  if (tip > 0) lines.push({ label: "Tip", amountPence: tip });
  if (discount > 0) lines.push({ label: "Discount", amountPence: discount, isDeduction: true });
  return lines;
}

function formatDate(value: string | null): string {
  const d = value ? new Date(value) : new Date();
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function paymentLabel(method: string | null): string {
  const m = (method ?? "").toLowerCase();
  if (m === "card") return "Card";
  if (m === "apple_pay") return "Apple Pay";
  if (m === "google_pay") return "Google Pay";
  if (m === "wallet") return "Digital wallet";
  return method || "Digital payment";
}

async function renderPdf(args: {
  trip: TripInvoiceRow;
  invoiceNo: string;
  currency: string;
  company: { name: string; email: string; phone: string; website: string; address: string };
  tagline: string;
  customerName: string;
}): Promise<Uint8Array> {
  const { trip, invoiceNo, currency, company, tagline, customerName } = args;
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595.28, 841.89]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const navy = rgb(0.05, 0.09, 0.19);
  const gold = rgb(0.78, 0.62, 0.25);
  const grey = rgb(0.42, 0.45, 0.51);

  let y = 800;
  const left = 48;
  const right = 547;

  page.drawRectangle({ x: 0, y: 762, width: 595.28, height: 80, color: navy });
  page.drawText(company.name || "ONECAB", { x: left, y: 806, size: 22, font: bold, color: gold });
  page.drawText(tagline || "One App. Every Journey.", { x: left, y: 788, size: 9, font, color: rgb(1, 1, 1) });
  page.drawText("TRIP INVOICE", { x: right - bold.widthOfTextAtSize("TRIP INVOICE", 14), y: 806, size: 14, font: bold, color: rgb(1, 1, 1) });
  page.drawText(invoiceNo, { x: right - font.widthOfTextAtSize(invoiceNo, 10), y: 788, size: 10, font, color: rgb(1, 1, 1) });

  y = 730;
  const meta: Array<[string, string]> = [
    ["Invoice date", formatDate(trip.completed_at ?? trip.created_at)],
    ["Trip reference", tripDisplayId(trip)],
    ["Passenger", customerName],
    ["Payment method", paymentLabel(trip.payment_method)],
  ];
  for (const [label, value] of meta) {
    page.drawText(label, { x: left, y, size: 9, font, color: grey });
    page.drawText(value, { x: left + 120, y, size: 10, font: bold, color: navy });
    y -= 18;
  }

  y -= 10;
  page.drawText("Journey", { x: left, y, size: 11, font: bold, color: navy });
  y -= 16;
  for (const [label, value] of [
    ["Pickup", trip.pickup_address ?? "—"],
    ["Drop-off", trip.dropoff_address ?? "—"],
  ] as Array<[string, string]>) {
    page.drawText(label, { x: left, y, size: 9, font, color: grey });
    const text = value.length > 68 ? `${value.slice(0, 65)}...` : value;
    page.drawText(text, { x: left + 120, y, size: 9, font, color: navy });
    y -= 16;
  }

  y -= 14;
  page.drawRectangle({ x: left, y: y - 4, width: right - left, height: 22, color: rgb(0.96, 0.96, 0.98) });
  page.drawText("Description", { x: left + 8, y: y + 3, size: 9, font: bold, color: navy });
  page.drawText("Amount", { x: right - 60, y: y + 3, size: 9, font: bold, color: navy });
  y -= 24;

  for (const line of buildLines(trip)) {
    const amount = `${line.isDeduction ? "-" : ""}${money(line.amountPence, currency)}`;
    page.drawText(line.label, { x: left + 8, y, size: 10, font, color: navy });
    page.drawText(amount, { x: right - 8 - font.widthOfTextAtSize(amount, 10), y, size: 10, font, color: navy });
    y -= 18;
  }

  y -= 8;
  page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 1, color: rgb(0.85, 0.86, 0.9) });
  y -= 22;
  const total = money(getTripSettlementFarePence(trip), currency);
  page.drawText("TOTAL PAID", { x: left + 8, y, size: 12, font: bold, color: navy });
  page.drawText(total, { x: right - 8 - bold.widthOfTextAtSize(total, 14), y: y - 2, size: 14, font: bold, color: gold });

  const footerParts = [company.address, company.phone, company.email, company.website].filter(Boolean);
  page.drawText(footerParts.join("  •  ").slice(0, 120), { x: left, y: 60, size: 8, font, color: grey });
  page.drawText("This is a payment receipt for a completed journey. No cash is handled on the ONECAB platform.", {
    x: left,
    y: 46,
    size: 8,
    font,
    color: grey,
  });

  return await pdf.save();
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function buildEmailHtml(args: {
  companyName: string;
  invoiceNo: string;
  tripRef: string;
  total: string;
  date: string;
  pickup: string;
  dropoff: string;
}): string {
  return `<!doctype html><html><body style="margin:0;background:#f5f6f8;font-family:Helvetica,Arial,sans-serif;color:#0d1730">
  <div style="max-width:560px;margin:24px auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e6e8ee">
    <div style="background:#0d1730;padding:20px 24px">
      <div style="color:#c79e40;font-size:20px;font-weight:bold">${args.companyName}</div>
      <div style="color:#ffffff;font-size:12px">Trip invoice ${args.invoiceNo}</div>
    </div>
    <div style="padding:24px">
      <p style="margin:0 0 16px">Thank you for travelling with us. Your invoice for trip <strong>${args.tripRef}</strong> on ${args.date} is attached.</p>
      <table style="width:100%;font-size:14px;border-collapse:collapse">
        <tr><td style="padding:6px 0;color:#6b7280">Pickup</td><td style="padding:6px 0;text-align:right">${args.pickup}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280">Drop-off</td><td style="padding:6px 0;text-align:right">${args.dropoff}</td></tr>
        <tr><td style="padding:12px 0;font-weight:bold;border-top:1px solid #e6e8ee">Total paid</td><td style="padding:12px 0;text-align:right;font-weight:bold;border-top:1px solid #e6e8ee">${args.total}</td></tr>
      </table>
      <p style="margin:20px 0 0;font-size:12px;color:#6b7280">Payment was taken digitally on the card or wallet used for the booking.</p>
    </div>
  </div></body></html>`;
}

export interface TripInvoiceResult {
  success: boolean;
  ok: boolean;
  error?: string;
  invoice_no?: string;
  invoiceNo?: string;
  pdf_url?: string;
  pdfUrl?: string;
  invoice_pdf_url?: string;
  invoice_generated_at?: string;
  invoice_email_status?: string;
  invoice_email_sent_at?: string;
  emailed?: boolean;
  skipped?: boolean;
  stage?: string;
}

async function signedUrl(supabase: SupabaseClient, path: string): Promise<string | null> {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
  if (error) {
    console.warn("[TRIP_INVOICE] signed_url_failed", error.message);
    return null;
  }
  return data?.signedUrl ?? null;
}

/** Generate (or reuse) the invoice PDF for a trip. Returns the storage path + signed URL. */
export async function ensureTripInvoicePdf(
  supabase: SupabaseClient,
  trip: TripInvoiceRow,
  opts: { force?: boolean } = {},
): Promise<{ trip: TripInvoiceRow; url: string | null; path: string }> {
  if (!opts.force && trip.invoice_pdf_path && trip.invoice_generated_at) {
    const url = await signedUrl(supabase, trip.invoice_pdf_path);
    if (url) {
      await supabase.from("trips").update({ invoice_pdf_url: url }).eq("id", trip.id);
      return { trip: { ...trip, invoice_pdf_url: url }, url, path: trip.invoice_pdf_path };
    }
  }

  const currency = (trip.currency_code || trip.currency || "GBP").toUpperCase();

  let invoiceNo = trip.invoice_no;
  if (!invoiceNo) {
    const { data, error } = await supabase.rpc("next_trip_invoice_number");
    if (error) throw new Error(`Invoice number allocation failed: ${error.message}`);
    invoiceNo = data as string;
  }

  const branding = await fetchCompanyBranding(supabase);
  const company = {
    name: branding.company.name || "ONECAB",
    email: branding.company.email,
    phone: branding.company.phone,
    website: branding.company.website,
    address: formatCompanyAddress(branding.company),
  };

  const pdfBytes = await renderPdf({
    trip,
    invoiceNo: invoiceNo!,
    currency,
    company,
    tagline: branding.branding.tagline,
    customerName: trip.passenger_name || "Passenger",
  });

  const path = `${trip.id}/${invoiceNo}.pdf`;
  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload(path, pdfBytes, { contentType: "application/pdf", upsert: true });
  if (uploadError) throw new Error(`Invoice upload failed: ${uploadError.message}`);

  const url = await signedUrl(supabase, path);
  const nowIso = new Date().toISOString();
  const patch: Record<string, unknown> = {
    invoice_no: invoiceNo,
    invoice_pdf_path: path,
    invoice_pdf_url: url,
    invoice_generated_at: nowIso,
    invoice_pdf_error: null,
    invoice_total_paid_pence: getTripSettlementFarePence(trip),
  };
  if (opts.force && trip.invoice_generated_at) patch.invoice_regenerated_at = nowIso;

  const { error: updateError } = await supabase.from("trips").update(patch).eq("id", trip.id);
  if (updateError) throw new Error(updateError.message);

  await logEvent(supabase, trip.id, "pdf_generated", "success", invoiceNo!, { path });

  return { trip: { ...trip, ...patch } as TripInvoiceRow, url, path };
}

/** Email the invoice PDF to the trip passenger. */
export async function sendTripInvoiceEmail(
  supabase: SupabaseClient,
  trip: TripInvoiceRow,
  pdfPath: string,
): Promise<{ ok: boolean; error?: string; email?: string }> {
  const email = await resolveCustomerEmail(supabase, trip.passenger_id);
  if (!email) {
    const message = "No email address on the passenger account";
    await supabase
      .from("trips")
      .update({ invoice_email_status: "skipped_no_email", invoice_email_error: message })
      .eq("id", trip.id);
    await logEvent(supabase, trip.id, "email", "skipped", message);
    return { ok: false, error: message };
  }

  const { data: download, error: downloadError } = await supabase.storage.from(BUCKET).download(pdfPath);
  if (downloadError || !download) {
    return { ok: false, error: downloadError?.message ?? "Invoice PDF not found" };
  }
  const bytes = new Uint8Array(await download.arrayBuffer());
  const currency = (trip.currency_code || trip.currency || "GBP").toUpperCase();
  const branding = await fetchCompanyBranding(supabase);
  const companyName = branding.company.name || "ONECAB";
  const invoiceNo = trip.invoice_no ?? "";

  const result = await sendResendEmail({
    to: email,
    subject: `Your ${companyName} invoice ${invoiceNo}`,
    html: buildEmailHtml({
      companyName,
      invoiceNo,
      tripRef: tripDisplayId(trip),
      total: money(getTripSettlementFarePence(trip), currency),
      date: formatDate(trip.completed_at ?? trip.created_at),
      pickup: trip.pickup_address ?? "—",
      dropoff: trip.dropoff_address ?? "—",
    }),
    attachments: [
      { filename: `${invoiceNo || "invoice"}.pdf`, content: bytesToBase64(bytes), contentType: "application/pdf" },
    ],
    tag: "trip_invoice",
  });

  const nowIso = new Date().toISOString();
  if (!result.ok) {
    await supabase
      .from("trips")
      .update({ invoice_email_status: "failed", invoice_email_error: result.message, invoice_email_sent: false })
      .eq("id", trip.id);
    await logEvent(supabase, trip.id, "email", "failed", result.message);
    return { ok: false, error: result.message, email };
  }

  await supabase
    .from("trips")
    .update({
      invoice_email_sent: true,
      invoice_email_sent_at: nowIso,
      invoice_email_status: "sent",
      invoice_email_error: null,
    })
    .eq("id", trip.id);
  await logEvent(supabase, trip.id, "email", "sent", email, { provider_id: result.id });

  return { ok: true, email };
}

export type TripInvoiceAction = "generate" | "regenerate" | "view" | "download" | "resend_email" | "send_email";

export async function handleTripInvoiceAction(
  supabase: SupabaseClient,
  tripId: string,
  action: TripInvoiceAction,
): Promise<TripInvoiceResult> {
  const trip = await fetchTrip(supabase, tripId);
  if (!trip) return { success: false, ok: false, error: "Trip not found" };

  const isCountable = ["completed", "no_show"].includes(trip.status);
  if (!isCountable && action === "generate") {
    return { success: false, ok: false, error: "Invoice is only available for completed trips", skipped: true };
  }

  try {
    const force = action === "regenerate";
    const { trip: updated, url, path } = await ensureTripInvoicePdf(supabase, trip, { force });

    let emailed = false;
    let emailError: string | undefined;
    const shouldEmail =
      action === "resend_email" ||
      action === "send_email" ||
      action === "regenerate" ||
      (action === "generate" && !updated.invoice_email_sent);

    if (shouldEmail) {
      const emailResult = await sendTripInvoiceEmail(supabase, updated, path);
      emailed = emailResult.ok;
      emailError = emailResult.error;
    }

    const fresh = await fetchTrip(supabase, tripId);
    return {
      success: true,
      ok: true,
      invoice_no: fresh?.invoice_no ?? undefined,
      invoiceNo: fresh?.invoice_no ?? undefined,
      pdf_url: url ?? undefined,
      pdfUrl: url ?? undefined,
      invoice_pdf_url: url ?? undefined,
      invoice_generated_at: fresh?.invoice_generated_at ?? undefined,
      invoice_email_status: fresh?.invoice_email_status ?? undefined,
      invoice_email_sent_at: fresh?.invoice_email_sent_at ?? undefined,
      emailed,
      ...(emailError && !emailed ? { error: emailError } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await supabase.from("trips").update({ invoice_pdf_error: message }).eq("id", tripId);
    await logEvent(supabase, tripId, action, "failed", message);
    return { success: false, ok: false, error: message };
  }
}
