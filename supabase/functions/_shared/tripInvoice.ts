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

  // passenger_id may be an auth user id or a customers.id — resolve both.
  const candidates: string[] = [passengerId];
  const { data: customer } = await supabase
    .from("customers")
    .select("user_id")
    .or(`id.eq.${passengerId},user_id.eq.${passengerId}`)
    .maybeSingle();
  if (customer?.user_id && !candidates.includes(customer.user_id)) candidates.push(customer.user_id);

  for (const userId of candidates) {
    const { data, error } = await supabase.auth.admin.getUserById(userId);
    if (error) continue;
    const email = data?.user?.email?.trim();
    if (email && email.includes("@")) return email;
  }
  console.warn("[TRIP_INVOICE] customer_email_lookup_failed", passengerId);
  return null;
}

interface InvoiceLine {
  label: string;
  amountPence: number;
}

/** Line items exactly as the existing ONECAB customer invoice lays them out. */
function buildLines(trip: TripInvoiceRow): InvoiceLine[] {
  const total = getTripSettlementFarePence(trip);
  const waiting = trip.total_waiting_charge_pence ?? 0;
  const extras = trip.extras_pence ?? 0;
  const airport = trip.airport_charge_pence ?? 0;
  const tip = trip.tip_pence ?? 0;
  const discount = (trip.discount_pence ?? 0) + (trip.offer_discount_pence ?? 0);

  const rideFare = Math.max(total - waiting - extras - airport - tip, 0);
  const originalFare = trip.base_fare_pence && trip.base_fare_pence > 0
    ? trip.base_fare_pence
    : rideFare + discount;

  const lines: InvoiceLine[] = [{ label: "Original fare", amountPence: originalFare }];
  lines.push({ label: discount > 0 ? "Ride fare after promotion" : "Ride fare", amountPence: rideFare });
  if (waiting > 0) lines.push({ label: "Waiting time", amountPence: waiting });
  if (airport > 0) lines.push({ label: "Airport charge", amountPence: airport });
  if (extras > 0) lines.push({ label: "Extra charges", amountPence: extras });
  if (tip > 0) lines.push({ label: "Tip", amountPence: tip });
  return lines;
}

function formatDate(value: string | null): string {
  const d = value ? new Date(value) : new Date();
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  return `${formatDate(value)}, ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
}

function paymentLabel(method: string | null): string {
  const m = (method ?? "").toLowerCase();
  if (m === "card") return "Card";
  if (m === "apple_pay") return "Apple Pay";
  if (m === "google_pay") return "Google Pay";
  if (m === "wallet") return "Digital wallet";
  return method || "Digital payment";
}

interface RenderArgs {
  trip: TripInvoiceRow;
  invoiceNo: string;
  currency: string;
  company: { name: string; email: string; phone: string; website: string; address: string };
  tagline: string;
  customerName: string;
  customerEmail: string;
}

function buildHtmlData(args: RenderArgs): TripInvoiceHtmlData {
  const { trip, invoiceNo, currency, company, tagline, customerName, customerEmail } = args;
  const dateLabel = formatDate(trip.completed_at ?? trip.created_at);
  const total = getTripSettlementFarePence(trip);

  return {
    invoiceNo,
    invoiceTitle: "INVOICE",
    tripRef: tripDisplayId(trip),
    invoiceDate: dateLabel,
    paymentMethod: paymentLabel(trip.payment_method),
    currencyCode: currency,
    customerName: customerName || "Customer",
    customerPhone: "—",
    customerEmail: customerEmail || "—",
    pickupLine: `${trip.pickup_address ?? "—"} — ${formatDateTime(trip.completed_at ?? trip.created_at)}`,
    dropoffLine: `${trip.dropoff_address ?? "—"} — ${formatDateTime(trip.completed_at ?? trip.created_at)}`,
    items: buildLines(trip).map((line) => ({
      description: line.label,
      date: dateLabel,
      qty: 1,
      unit: money(line.amountPence, currency),
      amount: money(line.amountPence, currency),
    })),
    subtotal: money(total, currency),
    taxLabel: "TAX (0%)",
    tax: money(0, currency),
    total: money(total, currency),
    company,
    tagline: (tagline || "One App. Every Journey.").toUpperCase(),
    footerHeadline: `THANK YOU FOR RIDING WITH ${(company.name || "ONECAB").toUpperCase()}!`,
    footerText: "If you have any questions, please contact our support team.",
  };
}

async function htmlToPdfViaBrowserless(html: string): Promise<Uint8Array | null> {
  const token = Deno.env.get("BROWSERLESS_TOKEN")?.trim();
  if (!token) return null;
  const baseUrl = (Deno.env.get("BROWSERLESS_URL") || "https://production-sfo.browserless.io").replace(/\/$/, "");
  try {
    const response = await fetch(`${baseUrl}/pdf?token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        html,
        options: {
          printBackground: true,
          format: "A4",
          margin: { top: "10mm", right: "10mm", bottom: "10mm", left: "10mm" },
        },
      }),
    });
    if (!response.ok) {
      console.warn("[TRIP_INVOICE] browserless_pdf_failed", response.status);
      return null;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    return new TextDecoder().decode(bytes.slice(0, 5)).startsWith("%PDF") ? bytes : null;
  } catch (err) {
    console.warn("[TRIP_INVOICE] browserless_pdf_error", err instanceof Error ? err.message : String(err));
    return null;
  }
}

/** pdf-lib fallback that mirrors the same ONECAB invoice layout. */
async function renderPdfLibFallback(data: TripInvoiceHtmlData): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595.28, 841.89]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.07, 0.07, 0.07);
  const gold = rgb(0.96, 0.7, 0.004);
  const grey = rgb(0.35, 0.35, 0.35);
  const panel = rgb(0.957, 0.957, 0.957);

  const left = 40;
  const right = 555;
  const width = right - left;
  const nameUpper = (data.company.name || "ONECAB").toUpperCase();

  page.drawText(nameUpper.slice(0, 3), { x: left, y: 780, size: 26, font: bold, color: ink });
  page.drawText(nameUpper.slice(3), {
    x: left + bold.widthOfTextAtSize(nameUpper.slice(0, 3), 26),
    y: 780,
    size: 26,
    font: bold,
    color: gold,
  });
  page.drawText(data.tagline, { x: left, y: 766, size: 7.5, font: bold, color: ink });

  const titleWidth = bold.widthOfTextAtSize(data.invoiceTitle, 26);
  page.drawText(data.invoiceTitle, { x: right - titleWidth, y: 780, size: 26, font: bold, color: ink });

  const pill = `#${data.invoiceNo}`;
  const pillWidth = bold.widthOfTextAtSize(pill, 10) + 24;
  page.drawRectangle({ x: right - pillWidth, y: 740, width: pillWidth, height: 22, color: gold });
  page.drawText(pill, { x: right - pillWidth + 12, y: 747, size: 10, font: bold, color: ink });

  let cy = 724;
  for (const line of [
    `Phone: ${data.company.phone}`,
    `Email: ${data.company.email}`,
    `Website: ${data.company.website}`,
    "Address:",
    data.company.address,
  ]) {
    const text = line.length > 78 ? `${line.slice(0, 75)}...` : line;
    page.drawText(text, { x: right - font.widthOfTextAtSize(text, 8), y: cy, size: 8, font, color: grey });
    cy -= 12;
  }

  page.drawRectangle({ x: left, y: cy - 8, width, height: 3, color: gold });
  let y = cy - 30;

  page.drawText("BILL TO", { x: left, y, size: 9.5, font: bold, color: ink });
  page.drawText("INVOICE DETAILS", { x: left + 190, y, size: 9.5, font: bold, color: ink });
  page.drawRectangle({ x: left + 380, y: y - 68, width: width - 380, height: 82, color: panel });
  page.drawText("DOWNLOAD THE", { x: left + 392, y: y - 6, size: 8, font: bold, color: ink });
  page.drawText(`${nameUpper} APP`, { x: left + 392, y: y - 17, size: 8, font: bold, color: ink });
  page.drawText("Google Play  ·  App Store", { x: left + 392, y: y - 40, size: 8, font, color: grey });

  let leftY = y - 16;
  for (const value of [data.customerName, data.customerPhone, data.customerEmail]) {
    page.drawText(value.slice(0, 30), { x: left, y: leftY, size: 9, font, color: grey });
    leftY -= 14;
  }

  let detailY = y - 16;
  for (const value of [
    `Invoice No.: ${data.invoiceNo}`,
    `Trip ID: ${data.tripRef}`,
    `Invoice Date: ${data.invoiceDate}`,
    `Payment Method: ${data.paymentMethod}`,
    `Currency: ${data.currencyCode}`,
  ]) {
    page.drawText(value, { x: left + 190, y: detailY, size: 9, font, color: grey });
    detailY -= 14;
  }

  y = Math.min(leftY, detailY) - 14;
  page.drawRectangle({ x: left, y: y - 24, width, height: 36, color: panel });
  page.drawText(`Pickup: ${data.pickupLine}`.slice(0, 105), { x: left + 10, y: y + 2, size: 8.5, font, color: grey });
  page.drawText(`Drop-off: ${data.dropoffLine}`.slice(0, 105), { x: left + 10, y: y - 12, size: 8.5, font, color: grey });
  y -= 46;

  const cols = [left + 8, left + 40, left + 260, left + 340, left + 400, left + 470];
  page.drawRectangle({ x: left, y: y - 6, width, height: 20, color: gold });
  ["#", "DESCRIPTION", "DATE", "QTY", "UNIT", "AMOUNT"].forEach((label, i) => {
    page.drawText(label, { x: cols[i], y, size: 8, font: bold, color: ink });
  });
  y -= 22;

  data.items.forEach((item, index) => {
    page.drawText(String(index + 1), { x: cols[0], y, size: 9, font, color: ink });
    page.drawText(item.description.slice(0, 40), { x: cols[1], y, size: 9, font, color: ink });
    page.drawText(item.date, { x: cols[2], y, size: 9, font, color: grey });
    page.drawText(String(item.qty), { x: cols[3], y, size: 9, font, color: grey });
    page.drawText(item.unit, { x: cols[4], y, size: 9, font, color: grey });
    page.drawText(item.amount, { x: cols[5], y, size: 9, font, color: ink });
    page.drawLine({ start: { x: left, y: y - 7 }, end: { x: right, y: y - 7 }, thickness: 0.5, color: rgb(0.9, 0.9, 0.9) });
    y -= 20;
  });

  y -= 10;
  page.drawText("SUBTOTAL", { x: cols[4], y, size: 9.5, font, color: grey });
  page.drawText(data.subtotal, { x: cols[5], y, size: 9.5, font, color: ink });
  y -= 16;
  page.drawText(data.taxLabel, { x: cols[4], y, size: 9.5, font, color: grey });
  page.drawText(data.tax, { x: cols[5], y, size: 9.5, font, color: ink });
  y -= 26;
  page.drawRectangle({ x: cols[4] - 10, y: y - 8, width: right - cols[4] + 10, height: 26, color: gold });
  page.drawText("TOTAL", { x: cols[4], y, size: 12, font: bold, color: ink });
  page.drawText(data.total, { x: cols[5], y, size: 12, font: bold, color: ink });

  y -= 36;
  page.drawText(data.footerHeadline, { x: left, y, size: 11, font: bold, color: ink });
  page.drawText(data.footerText, { x: left, y: y - 14, size: 9, font, color: grey });

  return await pdf.save();
}

async function renderPdf(args: RenderArgs): Promise<Uint8Array> {
  const data = buildHtmlData(args);
  const html = buildTripInvoiceHtml(data);
  const browserless = await htmlToPdfViaBrowserless(html);
  if (browserless) return browserless;
  return await renderPdfLibFallback(data);
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
