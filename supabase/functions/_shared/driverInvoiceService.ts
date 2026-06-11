import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { fetchCompanyBranding } from "./companyBranding.ts";
import {
  aggregateDriverInvoice,
  buildInvoiceItems,
  type DriverInvoiceAggregation,
} from "./driverInvoiceAggregation.ts";
import {
  buildDriverInvoiceEmail,
  buildDriverInvoiceHtml,
  type DriverInvoiceRenderData,
} from "./driverInvoiceHtml.ts";
import { buildDriverInvoicePdf } from "./driverInvoicePdf.ts";
import { sendResendEmail } from "./resendMail.ts";

const BUCKET = "driver-invoices";

export type DriverInvoiceAction = "generate" | "regenerate" | "send" | "resend" | "preview";

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function formatPeriod(start: string, end: string): string {
  return `${start} – ${end}`;
}

function statusLabel(status: string): string {
  if (status === "sent" || status === "viewed") return "Sent";
  if (status === "paid") return "Paid";
  return "Pending";
}

async function loadTemplate(supabase: SupabaseClient) {
  const { data } = await supabase
    .from("invoice_templates")
    .select("*")
    .eq("is_default", true)
    .maybeSingle();

  return data;
}

function buildRenderData(
  invoice: Record<string, unknown>,
  driver: Record<string, unknown>,
  region: Record<string, unknown> | null,
  companyBranding: Awaited<ReturnType<typeof fetchCompanyBranding>>,
  template: Record<string, unknown> | null,
): DriverInvoiceRenderData {
  const currency = (invoice.currency_code as string) || "GBP";
  const summaryRows = [
    { description: "Completed Card Trip Earnings", trips: Number(invoice.card_trips ?? 0), amountPence: Number(invoice.card_trip_earnings_pence ?? 0) },
    { description: "Completed Cash Trip Earnings", trips: Number(invoice.cash_trips ?? 0), amountPence: Number(invoice.cash_trip_earnings_pence ?? 0) },
    { description: "Airport Fee Earnings", trips: 0, amountPence: Number(invoice.airport_fee_earnings_pence ?? 0) },
    { description: "Extra Charge Earnings", trips: 0, amountPence: Number(invoice.extra_charge_earnings_pence ?? 0) },
  ];
  if (Number(invoice.bonuses_pence ?? 0) > 0) {
    summaryRows.push({ description: "Bonuses", trips: 0, amountPence: Number(invoice.bonuses_pence) });
  }
  if (Number(invoice.adjustments_pence ?? 0) !== 0) {
    summaryRows.push({ description: "Adjustments", trips: 0, amountPence: Number(invoice.adjustments_pence) });
  }
  if (Number(invoice.commission_pence ?? 0) > 0) {
    summaryRows.push({ description: "Platform Commission", trips: 0, amountPence: Number(invoice.commission_pence), isDeduction: true });
  }
  if (Number(invoice.cash_collected_pence ?? 0) > 0) {
    summaryRows.push({ description: "Cash Collected (Offset)", trips: 0, amountPence: Number(invoice.cash_collected_pence), isDeduction: true });
  }

  const branding = companyBranding.branding;
  if (template?.logo_url) branding.logoUrl = template.logo_url as string;

  return {
    invoiceNo: invoice.invoice_number as string,
    invoiceTitle: (template?.invoice_title as string) || "Driver Earnings Statement",
    driverName: `${driver.first_name ?? ""} ${driver.last_name ?? ""}`.trim(),
    driverId: (driver.driver_code as string) || (driver.id as string),
    regionName: (region?.name as string) || "—",
    currency,
    invoicePeriod: formatPeriod(invoice.period_start as string, invoice.period_end as string),
    invoiceStatus: statusLabel(invoice.status as string),
    generatedDate: (invoice.invoice_generated_at as string)?.slice(0, 10) || new Date().toISOString().slice(0, 10),
    summaryRows,
    totalTrips: Number(invoice.completed_trips ?? 0),
    cashTrips: Number(invoice.cash_trips ?? 0),
    cardTrips: Number(invoice.card_trips ?? 0),
    grossEarningsPence: Number(invoice.gross_earnings_pence ?? 0),
    airportFeeEarningsPence: Number(invoice.airport_fee_earnings_pence ?? 0),
    extraChargeEarningsPence: Number(invoice.extra_charge_earnings_pence ?? 0),
    bonusesPence: Number(invoice.bonuses_pence ?? 0),
    adjustmentsPence: Number(invoice.adjustments_pence ?? 0),
    platformCommissionPence: Number(invoice.commission_pence ?? 0),
    cashCollectedOffsetPence: Number(invoice.cash_collected_pence ?? 0),
    netDriverEarningsPence: Number(invoice.net_earnings_pence ?? 0),
    company: {
      ...companyBranding.company,
      name: (template?.company_name as string) || companyBranding.company.name,
      email: companyBranding.company.email || (template?.company_email as string) || "",
      phone: companyBranding.company.phone || (template?.company_phone as string) || "",
      website: companyBranding.company.website || (template?.company_website as string) || "",
      address: companyBranding.company.address || (template?.company_address as string) || "",
      legalName: companyBranding.company.legalName,
      city: companyBranding.company.city,
      state: companyBranding.company.state,
      zipCode: companyBranding.company.zipCode,
      country: companyBranding.company.country,
    },
    branding,
    footerText: (template?.footer_text as string) || (template?.notes_footer as string) || undefined,
  };
}

async function generatePdfForInvoice(
  supabase: SupabaseClient,
  invoice: Record<string, unknown>,
): Promise<{ pdfPath: string; pdfUrl: string; html: string }> {
  const { data: driver } = await supabase
    .from("drivers")
    .select("id, first_name, last_name, driver_code, email")
    .eq("id", invoice.driver_id)
    .single();

  const { data: region } = await supabase
    .from("regions")
    .select("name")
    .eq("id", invoice.region_id)
    .maybeSingle();

  const companyBranding = await fetchCompanyBranding(supabase);
  const template = await loadTemplate(supabase);
  const renderData = buildRenderData(invoice, driver ?? {}, region, companyBranding, template);
  const html = buildDriverInvoiceHtml(renderData);
  const pdfBytes = await buildDriverInvoicePdf(renderData);
  const fileName = `ONECAB_Driver_Invoice_${invoice.invoice_number}.pdf`;
  const storagePath = `${invoice.driver_id}/${invoice.id}/${fileName}`;

  const { error: uploadErr } = await supabase.storage.from(BUCKET).upload(storagePath, pdfBytes, {
    contentType: "application/pdf",
    upsert: true,
  });
  if (uploadErr) throw new Error(`PDF upload failed: ${uploadErr.message}`);

  await supabase.storage.from(BUCKET).upload(
    storagePath.replace(/\.pdf$/, ".html"),
    new TextEncoder().encode(html),
    { contentType: "text/html", upsert: true },
  ).catch(() => undefined);

  const { data: signed } = await supabase.storage.from(BUCKET).createSignedUrl(storagePath, 60 * 60 * 24 * 365);
  if (!signed?.signedUrl) throw new Error("Failed to create signed URL");

  return { pdfPath: storagePath, pdfUrl: signed.signedUrl, html };
}

export async function generateDriverInvoice(
  supabase: SupabaseClient,
  params: {
    driverId: string;
    periodStart: string;
    periodEnd: string;
    regionId: string;
    serviceAreaId?: string | null;
    regenerateInvoiceId?: string;
  },
): Promise<{ ok: boolean; invoice_id?: string; error?: string }> {
  const { data: region } = await supabase.from("regions").select("currency_code, name").eq("id", params.regionId).single();
  if (!region?.currency_code) return { ok: false, error: "Region has no currency" };

  if (!params.regenerateInvoiceId) {
    const { data: existing } = await supabase
      .from("invoices")
      .select("id")
      .eq("driver_id", params.driverId)
      .eq("region_id", params.regionId)
      .eq("period_start", params.periodStart)
      .eq("period_end", params.periodEnd)
      .not("status", "eq", "cancelled")
      .maybeSingle();
    if (existing) return { ok: false, error: "Invoice already exists for this driver and period" };
  }

  const agg = await aggregateDriverInvoice(supabase, {
    driverId: params.driverId,
    periodStart: params.periodStart,
    periodEnd: params.periodEnd,
    currencyCode: region.currency_code,
    serviceAreaId: params.serviceAreaId,
  });

  const template = await loadTemplate(supabase);
  let invoiceId = params.regenerateInvoiceId;
  let invoiceNumber: string;

  if (invoiceId) {
    const { data: existingInv } = await supabase.from("invoices").select("invoice_number").eq("id", invoiceId).single();
    invoiceNumber = existingInv?.invoice_number ?? "";
    await supabase.from("invoice_items").delete().eq("invoice_id", invoiceId);
  } else {
    const { data: invNum } = await supabase.rpc("generate_invoice_number");
    invoiceNumber = invNum || `INV-${Date.now()}`;
    const { data: created, error: insertErr } = await supabase
      .from("invoices")
      .insert({
        invoice_number: invoiceNumber,
        driver_id: params.driverId,
        template_id: template?.id ?? null,
        period_start: params.periodStart,
        period_end: params.periodEnd,
        region_id: params.regionId,
        service_area_id: params.serviceAreaId || null,
        currency_code: region.currency_code,
        gross_earnings_pence: agg.grossEarningsPence,
        commission_pence: agg.platformCommissionPence,
        bonuses_pence: agg.bonusesPence,
        penalties_pence: 0,
        adjustments_pence: agg.adjustmentsPence,
        cash_collected_pence: agg.cashCollectedOffsetPence,
        net_earnings_pence: agg.netDriverEarningsPence,
        completed_trips: agg.totalTrips,
        card_trips: agg.cardTrips,
        cash_trips: agg.cashTrips,
        card_trip_earnings_pence: agg.cardTripEarningsPence,
        cash_trip_earnings_pence: agg.cashTripEarningsPence,
        airport_fee_earnings_pence: agg.airportFeeEarningsPence,
        extra_charge_earnings_pence: agg.extraChargeEarningsPence,
        status: "draft",
      })
      .select()
      .single();
    if (insertErr) return { ok: false, error: insertErr.message };
    invoiceId = created.id;
  }

  if (!invoiceId) return { ok: false, error: "Invoice ID missing" };

  if (params.regenerateInvoiceId) {
    await supabase.from("invoices").update({
      invoice_email_sent: false,
      invoice_email_status: null,
      invoice_email_error: null,
      gross_earnings_pence: agg.grossEarningsPence,
      commission_pence: agg.platformCommissionPence,
      bonuses_pence: agg.bonusesPence,
      adjustments_pence: agg.adjustmentsPence,
      cash_collected_pence: agg.cashCollectedOffsetPence,
      net_earnings_pence: agg.netDriverEarningsPence,
      completed_trips: agg.totalTrips,
      card_trips: agg.cardTrips,
      cash_trips: agg.cashTrips,
      card_trip_earnings_pence: agg.cardTripEarningsPence,
      cash_trip_earnings_pence: agg.cashTripEarningsPence,
      airport_fee_earnings_pence: agg.airportFeeEarningsPence,
      extra_charge_earnings_pence: agg.extraChargeEarningsPence,
    }).eq("id", invoiceId);
  }

  const items = buildInvoiceItems(invoiceId, agg);
  if (items.length) await supabase.from("invoice_items").insert(items);

  const { data: invoice } = await supabase.from("invoices").select("*").eq("id", invoiceId).single();
  if (!invoice) return { ok: false, error: "Invoice not found after create" };

  try {
    const { pdfPath, pdfUrl } = await generatePdfForInvoice(supabase, invoice);
    const now = new Date().toISOString();
    await supabase.from("invoices").update({
      pdf_storage_path: pdfPath,
      invoice_pdf_url: pdfUrl,
      invoice_generated_at: now,
      finalized_at: now,
      status: "finalized",
    }).eq("id", invoiceId);

    const tpl = await loadTemplate(supabase);
    if (tpl?.auto_email_enabled) {
      await sendDriverInvoiceEmail(supabase, invoiceId, false);
    }

    return { ok: true, invoice_id: invoiceId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await supabase.from("invoices").update({ invoice_email_status: "failed", invoice_email_error: msg }).eq("id", invoiceId);
    return { ok: false, error: msg, invoice_id: invoiceId };
  }
}

export async function sendDriverInvoiceEmail(
  supabase: SupabaseClient,
  invoiceId: string,
  forceResend: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const { data: invoice } = await supabase.from("invoices").select("*").eq("id", invoiceId).single();
  if (!invoice) return { ok: false, error: "Invoice not found" };
  if (invoice.invoice_email_sent && !forceResend) return { ok: true };

  const { data: driver } = await supabase
    .from("drivers")
    .select("first_name, last_name, email, driver_code")
    .eq("id", invoice.driver_id)
    .single();
  if (!driver?.email) {
    await supabase.from("invoices").update({ invoice_email_status: "failed", invoice_email_error: "Driver email not found" }).eq("id", invoiceId);
    return { ok: false, error: "Driver email not found" };
  }

  let pdfPath = invoice.pdf_storage_path as string | null;
  if (!pdfPath) {
    const gen = await generatePdfForInvoice(supabase, invoice);
    pdfPath = gen.pdfPath;
    await supabase.from("invoices").update({
      pdf_storage_path: gen.pdfPath,
      invoice_pdf_url: gen.pdfUrl,
      invoice_generated_at: new Date().toISOString(),
    }).eq("id", invoiceId);
  }

  const { data: fileData, error: dlErr } = await supabase.storage.from(BUCKET).download(pdfPath!);
  if (dlErr || !fileData) return { ok: false, error: dlErr?.message ?? "PDF download failed" };

  const companyBranding = await fetchCompanyBranding(supabase);
  const template = await loadTemplate(supabase);
  const currency = invoice.currency_code || "GBP";
  const sym = currency === "GBP" ? "£" : "$";
  const netDisplay = `${sym}${(Number(invoice.net_earnings_pence) / 100).toFixed(2)}`;

  const email = buildDriverInvoiceEmail({
    driverName: `${driver.first_name} ${driver.last_name}`.trim(),
    invoiceNo: invoice.invoice_number,
    invoicePeriod: formatPeriod(invoice.period_start, invoice.period_end),
    totalTrips: Number(invoice.completed_trips ?? 0),
    netDriverEarnings: netDisplay,
    companyName: companyBranding.company.name,
    companyAddress: companyBranding.company.address,
    companyPhone: companyBranding.company.phone,
    companyEmail: companyBranding.company.email,
    companyWebsite: companyBranding.company.website,
    emailBodyTemplate: template?.email_body as string | undefined,
  });

  const subject = (template?.email_subject as string || email.subject)
    .replace(/\{\{invoiceNo\}\}/g, invoice.invoice_number);

  const pdfBytes = new Uint8Array(await fileData.arrayBuffer());
  const sendResult = await sendResendEmail({
    to: driver.email,
    subject,
    html: email.html,
    text: email.text,
    attachments: [{
      filename: `ONECAB_Driver_Invoice_${invoice.invoice_number}.pdf`,
      content: bytesToBase64(pdfBytes),
    }],
    tag: "driver_monthly_invoice",
  });

  const now = new Date().toISOString();
  if (!sendResult.ok) {
    await supabase.from("invoices").update({
      invoice_email_status: "failed",
      invoice_email_error: sendResult.message,
    }).eq("id", invoiceId);
    await supabase.from("invoice_delivery_logs").insert({
      invoice_id: invoiceId,
      sent_to_email: driver.email,
      delivery_status: "failed",
      error_message: sendResult.message,
    }).catch(() => undefined);
    return { ok: false, error: sendResult.message };
  }

  await supabase.from("invoices").update({
    status: "sent",
    sent_at: now,
    invoice_email_sent: true,
    invoice_email_sent_at: now,
    invoice_email_status: "sent",
    invoice_email_error: null,
  }).eq("id", invoiceId);

  await supabase.from("invoice_delivery_logs").insert({
    invoice_id: invoiceId,
    sent_to_email: driver.email,
    delivery_status: "sent",
    sent_at: now,
  }).catch(() => undefined);

  return { ok: true };
}

export async function previewDriverInvoiceHtml(
  supabase: SupabaseClient,
  invoiceId: string,
): Promise<{ html?: string; error?: string }> {
  const { data: invoice } = await supabase.from("invoices").select("*").eq("id", invoiceId).single();
  if (!invoice) return { error: "Invoice not found" };

  const { data: driver } = await supabase.from("drivers").select("*").eq("id", invoice.driver_id).single();
  const { data: region } = await supabase.from("regions").select("name").eq("id", invoice.region_id).maybeSingle();
  const companyBranding = await fetchCompanyBranding(supabase);
  const template = await loadTemplate(supabase);
  return { html: buildDriverInvoiceHtml(buildRenderData(invoice, driver ?? {}, region, companyBranding, template)) };
}

export async function getDriverInvoiceUrls(
  supabase: SupabaseClient,
  invoiceId: string,
): Promise<{ pdf_url?: string; html_url?: string; error?: string }> {
  const { data: invoice } = await supabase.from("invoices").select("pdf_storage_path, invoice_pdf_url").eq("id", invoiceId).single();
  if (!invoice?.pdf_storage_path && !invoice?.invoice_pdf_url) return { error: "PDF not generated" };

  if (invoice.pdf_storage_path) {
    const { data: pdfSigned } = await supabase.storage.from(BUCKET).createSignedUrl(invoice.pdf_storage_path, 3600);
    const htmlPath = invoice.pdf_storage_path.replace(/\.pdf$/, ".html");
    const { data: htmlSigned } = await supabase.storage.from(BUCKET).createSignedUrl(htmlPath, 3600);
    return { pdf_url: pdfSigned?.signedUrl ?? invoice.invoice_pdf_url ?? undefined, html_url: htmlSigned?.signedUrl };
  }

  return { pdf_url: invoice.invoice_pdf_url ?? undefined };
}
