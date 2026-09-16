import { type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { formatPenceWithCurrency } from "./currency.ts";
import { fetchCompanyBranding, formatCompanyAddress } from "./companyBranding.ts";
import { buildDriverInvoicePdf } from "./driverInvoicePdf.ts";
import type { DriverInvoiceRenderData } from "./driverInvoiceHtml.ts";

export const STATEMENT_PDF_BUCKET = "driver-statement-pdfs";
const ADMIN_INVOICE_BUCKET = "driver-invoices";

function brandedInvoiceStoragePath(driverId: string, invoiceNo: string): string {
  return `invoices/drivers/${driverId}/${invoiceNo}.pdf`;
}

export interface DeliverStatementResult {
  success: boolean;
  invoice_id: string;
  driver_id: string;
  pdf_storage_path: string | null;
  signed_url: string | null;
  inbox_message_id: string | null;
  error?: string;
}

function formatPeriodLabel(periodStart: string): string {
  const d = new Date(`${periodStart}T00:00:00`);
  return d.toLocaleString("en", { month: "long", year: "numeric" });
}

async function loadInvoiceBundle(supabase: SupabaseClient, invoiceId: string) {
  const { data: invoice, error } = await supabase
    .from("invoices")
    .select(`
      *,
      invoice_items(*),
      regions(name, currency_code),
      invoice_templates(company_name, invoice_title, notes_footer)
    `)
    .eq("id", invoiceId)
    .single();

  if (error || !invoice) {
    throw new Error(error?.message || "Invoice not found");
  }

  if (!invoice.driver_id) {
    throw new Error("Invoice has no driver_id");
  }

  const { data: driver } = await supabase
    .from("drivers")
    .select("id, first_name, last_name, driver_code")
    .eq("id", invoice.driver_id)
    .single();

  if (!driver) {
    throw new Error("Driver not found for invoice");
  }

  return { invoice, driver };
}

function statusLabel(status: string | null | undefined): string {
  if (status === "sent" || status === "viewed") return "Sent";
  if (status === "paid") return "Paid";
  if (status === "finalized") return "Finalized";
  return "Pending";
}

function formatPeriod(start: string, end: string): string {
  const startDate = new Date(`${start}T00:00:00`);
  const endDate = new Date(`${end}T00:00:00`);
  const fmt = (d: Date) =>
    d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  return `${fmt(startDate)} – ${fmt(endDate)}`;
}

async function buildRenderData(
  supabase: SupabaseClient,
  invoice: any,
  driver: any,
): Promise<DriverInvoiceRenderData> {
  const template = invoice.invoice_templates;
  const { company, branding } = await fetchCompanyBranding(supabase);
  const currency = invoice.regions?.currency_code || invoice.currency_code || "GBP";

  const companyAddress = formatCompanyAddress({
    ...company,
    address: company.address || template?.company_address || "",
  });

  const invoiceBranding = { ...branding };

  return {
    invoiceNo: invoice.invoice_number,
    invoiceTitle: template?.invoice_title || "Driver Earnings Statement",
    driverName: `${driver.first_name} ${driver.last_name}`.trim(),
    driverId: driver.driver_code || driver.id,
    regionName: invoice.regions?.name || "—",
    currency,
    invoicePeriod: formatPeriod(invoice.period_start, invoice.period_end),
    invoiceStatus: statusLabel(invoice.status),
    generatedDate: (invoice.invoice_generated_at as string | undefined)?.slice(0, 10)
      || new Date().toISOString().slice(0, 10),
    summaryRows: [
      { description: "Completed Card Trip Earnings", trips: invoice.card_trips ?? 0, amountPence: invoice.card_trip_earnings_pence ?? 0 },
      { description: "Completed Cash Trip Earnings", trips: invoice.cash_trips ?? 0, amountPence: invoice.cash_trip_earnings_pence ?? 0 },
      { description: "Airport Fee Earnings", trips: 0, amountPence: invoice.airport_fee_earnings_pence ?? 0 },
      { description: "Extra Charge Earnings", trips: 0, amountPence: invoice.extra_charge_earnings_pence ?? 0 },
      { description: "Bonuses", trips: 0, amountPence: invoice.bonuses_pence ?? 0 },
      { description: "Adjustments", trips: 0, amountPence: invoice.adjustments_pence ?? 0 },
      { description: "Platform Commission", trips: 0, amountPence: invoice.commission_pence ?? 0, isDeduction: true },
      { description: "Cash Collected (Offset)", trips: 0, amountPence: invoice.cash_collected_pence ?? 0, isDeduction: true },
    ],
    totalTrips: invoice.completed_trips ?? 0,
    cashTrips: invoice.cash_trips ?? 0,
    cardTrips: invoice.card_trips ?? 0,
    grossEarningsPence: invoice.gross_earnings_pence ?? 0,
    airportFeeEarningsPence: invoice.airport_fee_earnings_pence ?? 0,
    extraChargeEarningsPence: invoice.extra_charge_earnings_pence ?? 0,
    bonusesPence: invoice.bonuses_pence ?? 0,
    adjustmentsPence: invoice.adjustments_pence ?? 0,
    platformCommissionPence: invoice.commission_pence ?? 0,
    cashCollectedOffsetPence: invoice.cash_collected_pence ?? 0,
    netDriverEarningsPence: invoice.net_earnings_pence ?? 0,
    company: {
      ...company,
      name: template?.company_name || company.name || "ONECAB",
      legalName: template?.company_name || company.legalName || company.name || "ONECAB",
      email: company.email || template?.company_email || "",
      phone: company.phone || template?.company_phone || "",
      website: company.website || template?.company_website || "",
      address: companyAddress,
    },
    branding: invoiceBranding,
    footerText: template?.notes_footer || template?.footer_text || undefined,
  };
}

async function logDeliveryFailure(
  supabase: SupabaseClient,
  invoiceId: string,
  driverId: string | null,
  status: string,
  errorMessage: string,
) {
  await supabase.from("invoice_pdf_delivery_logs").insert({
    invoice_id: invoiceId,
    driver_id: driverId,
    status,
    error_message: errorMessage,
  });
}

async function upsertInboxMessage(
  supabase: SupabaseClient,
  invoice: any,
  pdfStoragePath: string | null,
): Promise<string | null> {
  const currencyCode = invoice.regions?.currency_code || invoice.currency_code;
  const netLabel = formatPenceWithCurrency(invoice.net_earnings_pence ?? 0, currencyCode);
  const periodLabel = formatPeriodLabel(invoice.period_start);
  const metadata = {
    invoice_id: invoice.id,
    invoice_number: invoice.invoice_number,
    period_start: invoice.period_start,
    period_end: invoice.period_end,
    net_earnings_pence: invoice.net_earnings_pence,
    currency_code: currencyCode,
    status: invoice.status,
    pdf_storage_path: pdfStoragePath,
  };

  const { data: existing } = await supabase
    .from("driver_inbox_messages")
    .select("id, metadata, dismissed_at")
    .eq("driver_id", invoice.driver_id)
    .contains("metadata", { invoice_id: invoice.id })
    .maybeSingle();

  if (existing?.id) {
    if (existing.dismissed_at) {
      return existing.id;
    }

    const { data: updated, error } = await supabase
      .from("driver_inbox_messages")
      .update({
        title: `Earnings Statement — ${periodLabel}`,
        body: `${invoice.invoice_number} · Net ${netLabel}`,
        type: "earnings",
        metadata: { ...(existing.metadata as Record<string, unknown> | null), ...metadata },
      })
      .eq("id", existing.id)
      .select("id")
      .single();

    if (error) throw new Error(error.message);
    return updated?.id ?? existing.id;
  }

  const { data: inserted, error } = await supabase
    .from("driver_inbox_messages")
    .insert({
      driver_id: invoice.driver_id,
      type: "earnings",
      title: `Earnings Statement — ${periodLabel}`,
      body: `${invoice.invoice_number} · Net ${netLabel}`,
      metadata,
    })
    .select("id")
    .single();

  if (error) throw new Error(error.message);
  return inserted?.id ?? null;
}

export async function deliverDriverStatement(
  supabase: SupabaseClient,
  invoiceId: string,
  options: { regeneratePdf?: boolean; sentByUserId?: string | null } = {},
): Promise<DeliverStatementResult> {
  const { invoice, driver } = await loadInvoiceBundle(supabase, invoiceId);
  let pdfStoragePath: string | null = invoice.pdf_storage_path;
  let signedUrl: string | null = null;
  let inboxMessageId: string | null = null;

  try {
    const shouldGenerate = options.regeneratePdf || !pdfStoragePath
      || !pdfStoragePath.startsWith("invoices/drivers/");
    if (shouldGenerate) {
      const renderData = await buildRenderData(supabase, invoice, driver);
      const pdfBytes = await buildDriverInvoicePdf(renderData);
      pdfStoragePath = brandedInvoiceStoragePath(invoice.driver_id, invoice.invoice_number);

      const { error: uploadError } = await supabase.storage
        .from(ADMIN_INVOICE_BUCKET)
        .upload(pdfStoragePath, pdfBytes, {
          contentType: "application/pdf",
          upsert: true,
        });

      if (uploadError) {
        throw new Error(`PDF upload failed: ${uploadError.message}`);
      }

      const { data: signed } = await supabase.storage
        .from(ADMIN_INVOICE_BUCKET)
        .createSignedUrl(pdfStoragePath, 60 * 60 * 24 * 365);

      const updatePayload: Record<string, unknown> = {
        pdf_storage_path: pdfStoragePath,
        invoice_pdf_url: signed?.signedUrl ?? null,
        invoice_generated_at: new Date().toISOString(),
        invoice_pdf_error: null,
      };

      if (invoice.status === "draft" || invoice.status === "finalized") {
        updatePayload.status = "sent";
        updatePayload.sent_at = new Date().toISOString();
      }
      if (options.sentByUserId) {
        updatePayload.sent_by = options.sentByUserId;
      }

      const { error: updateError } = await supabase
        .from("invoices")
        .update(updatePayload)
        .eq("id", invoice.id);

      if (updateError) {
        throw new Error(`Invoice update failed: ${updateError.message}`);
      }

      invoice.status = (updatePayload.status as string) || invoice.status;
    }

    if (pdfStoragePath) {
      const bucket = pdfStoragePath.startsWith("invoices/drivers/")
        ? ADMIN_INVOICE_BUCKET
        : STATEMENT_PDF_BUCKET;
      const { data: signed, error: signError } = await supabase.storage
        .from(bucket)
        .createSignedUrl(pdfStoragePath, 60 * 60);

      if (signError) {
        throw new Error(`Signed URL failed: ${signError.message}`);
      }
      signedUrl = signed?.signedUrl ?? null;
    }

    inboxMessageId = await upsertInboxMessage(supabase, invoice, pdfStoragePath);

    await supabase.from("invoice_pdf_delivery_logs").insert({
      invoice_id: invoice.id,
      driver_id: invoice.driver_id,
      status: "success",
      error_message: null,
    });

    return {
      success: true,
      invoice_id: invoice.id,
      driver_id: invoice.driver_id,
      pdf_storage_path: pdfStoragePath,
      signed_url: signedUrl,
      inbox_message_id: inboxMessageId,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logDeliveryFailure(
      supabase,
      invoice.id,
      invoice.driver_id,
      pdfStoragePath ? "inbox_failed" : "pdf_failed",
      message,
    );

    try {
      inboxMessageId = await upsertInboxMessage(supabase, invoice, pdfStoragePath);
    } catch {
      // inbox failure already logged above when relevant
    }

    return {
      success: false,
      invoice_id: invoice.id,
      driver_id: invoice.driver_id,
      pdf_storage_path: pdfStoragePath,
      signed_url: signedUrl,
      inbox_message_id: inboxMessageId,
      error: message,
    };
  }
}

async function signedUrlFromAdminInvoice(
  supabase: SupabaseClient,
  invoice: { pdf_storage_path?: string | null; invoice_pdf_url?: string | null },
): Promise<string | null> {
  if (invoice.invoice_pdf_url) {
    return invoice.invoice_pdf_url;
  }
  if (!invoice.pdf_storage_path?.startsWith("invoices/drivers/")) {
    return null;
  }
  const { data: signed, error } = await supabase.storage
    .from(ADMIN_INVOICE_BUCKET)
    .createSignedUrl(invoice.pdf_storage_path, 60 * 60);
  if (error || !signed?.signedUrl) return null;
  return signed.signedUrl;
}

export async function getDriverStatementSignedUrl(
  supabase: SupabaseClient,
  invoiceId: string,
  driverId: string,
): Promise<{ signed_url: string | null; pdf_unavailable: boolean; invoice: any }> {
  const { data: invoice, error } = await supabase
    .from("invoices")
    .select(`
      id, driver_id, invoice_number, period_start, period_end, currency_code,
      net_earnings_pence, completed_trips, status, pdf_storage_path, invoice_pdf_url,
      gross_earnings_pence, commission_pence, bonuses_pence, penalties_pence,
      adjustments_pence, cash_collected_pence,
      regions(name, currency_code),
      invoice_items(*),
      invoice_templates(company_name, invoice_title, notes_footer)
    `)
    .eq("id", invoiceId)
    .eq("driver_id", driverId)
    .in("status", ["sent", "viewed", "finalized"])
    .single();

  if (error || !invoice) {
    throw new Error("Statement not found");
  }

  const adminUrl = await signedUrlFromAdminInvoice(supabase, invoice);
  if (adminUrl) {
    if (invoice.status === "sent") {
      await supabase
        .from("invoices")
        .update({ status: "viewed", viewed_at: new Date().toISOString() })
        .eq("id", invoice.id);
    }
    return { signed_url: adminUrl, pdf_unavailable: false, invoice };
  }

  if (!invoice.pdf_storage_path) {
    const delivered = await deliverDriverStatement(supabase, invoiceId, { regeneratePdf: true });
    if (!delivered.success || !delivered.pdf_storage_path) {
      return { signed_url: null, pdf_unavailable: true, invoice };
    }
    return {
      signed_url: delivered.signed_url,
      pdf_unavailable: false,
      invoice: { ...invoice, pdf_storage_path: delivered.pdf_storage_path },
    };
  }

  const { data: signed, error: signError } = await supabase.storage
    .from(STATEMENT_PDF_BUCKET)
    .createSignedUrl(invoice.pdf_storage_path, 60 * 60);

  if (signError || !signed?.signedUrl) {
    const delivered = await deliverDriverStatement(supabase, invoiceId, { regeneratePdf: true });
    return {
      signed_url: delivered.signed_url,
      pdf_unavailable: !delivered.success,
      invoice,
    };
  }

  if (invoice.status === "sent") {
    await supabase
      .from("invoices")
      .update({ status: "viewed", viewed_at: new Date().toISOString() })
      .eq("id", invoice.id);
  }

  return { signed_url: signed.signedUrl, pdf_unavailable: false, invoice };
}
