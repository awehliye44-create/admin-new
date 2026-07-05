import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { fetchCompanyBranding, formatCompanyAddress } from "./companyBranding.ts";
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
import { buildDriverInvoicePdf, isBrandedDriverInvoicePdf } from "./driverInvoicePdf.ts";
import { prepareDriverInvoiceHtmlForPdf } from "./driverInvoiceHtml.ts";
import { formatResendFromAddress, sendResendEmail } from "./resendMail.ts";

const BUCKET = "driver-invoices";
const LEGACY_BUCKET = "driver-statement-pdfs";

export type DriverInvoiceAction =
  | "generate"
  | "regenerate"
  | "view"
  | "download"
  | "send_email"
  | "resend_email"
  | "send"
  | "resend"
  | "preview";

export interface DriverInvoiceResponse {
  success: boolean;
  ok?: boolean;
  error?: string;
  invoiceNo?: string;
  invoice_id?: string;
  pdfUrl?: string;
  pdf_url?: string;
  html_url?: string;
  emailStatus?: string | null;
  message?: string;
  stage?: "pdf_generation" | "email_sending" | "validation" | "unknown";
}

function log(step: string, details: Record<string, unknown> = {}) {
  console.log("[DRIVER_INVOICE]", JSON.stringify({ step, ...details }));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function invoiceStoragePath(driverId: string, invoiceNo: string): string {
  return `invoices/drivers/${driverId}/${invoiceNo}.pdf`;
}

function resolvePdfStoragePath(invoice: Record<string, unknown>, driverId: string | null): string {
  const invoiceNo = invoice.invoice_number as string;
  const invoiceId = invoice.id as string;
  if (driverId) return invoiceStoragePath(driverId, invoiceNo);
  return `invoices/by-id/${invoiceId}/${invoiceNo}.pdf`;
}

function extractDriverIdFromStoragePath(path: string | null | undefined): string | null {
  if (!path) return null;
  const segments = path.split("/").filter(Boolean);
  for (const segment of segments) {
    if (isValidUuid(segment)) return segment;
  }
  return null;
}

async function resolveDriverIdForInvoice(
  supabase: SupabaseClient,
  invoice: Record<string, unknown>,
): Promise<string | null> {
  if (isValidUuid(invoice.driver_id)) {
    return invoice.driver_id as string;
  }

  const fromPath = extractDriverIdFromStoragePath(invoice.pdf_storage_path as string | null);
  if (fromPath) return fromPath;

  const invoiceId = invoice.id as string;
  if (invoiceId) {
    const { data: inbox } = await supabase
      .from("driver_inbox_messages")
      .select("driver_id")
      .contains("metadata", { invoice_id: invoiceId })
      .not("driver_id", "is", null)
      .limit(1)
      .maybeSingle();
    if (isValidUuid(inbox?.driver_id)) return inbox!.driver_id as string;

    const { data: delivery } = await supabase
      .from("invoice_pdf_delivery_logs")
      .select("driver_id")
      .eq("invoice_id", invoiceId)
      .not("driver_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (isValidUuid(delivery?.driver_id)) return delivery!.driver_id as string;
  }

  if (invoice.region_id && invoice.period_start && invoice.period_end) {
    const { data: statement } = await supabase
      .from("driver_statements")
      .select("driver_id")
      .eq("region_id", invoice.region_id as string)
      .eq("period_start", invoice.period_start as string)
      .eq("period_end", invoice.period_end as string)
      .eq("net_earnings_pence", Number(invoice.net_earnings_pence ?? 0))
      .not("driver_id", "is", null)
      .limit(1)
      .maybeSingle();
    if (isValidUuid(statement?.driver_id)) return statement!.driver_id as string;

    const { data: ledgerRows } = await supabase
      .from("driver_wallet_ledger")
      .select("driver_id")
      .eq("region_id", invoice.region_id as string)
      .gte("created_at", `${invoice.period_start as string}T00:00:00Z`)
      .lte("created_at", `${invoice.period_end as string}T23:59:59Z`)
      .not("driver_id", "is", null);
    const uniqueDrivers = [...new Set((ledgerRows ?? []).map((row) => row.driver_id).filter(isValidUuid))];
    if (uniqueDrivers.length === 1) return uniqueDrivers[0];
  }

  return null;
}

async function hydrateInvoiceDriverId(
  supabase: SupabaseClient,
  invoice: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (isValidUuid(invoice.driver_id)) return invoice;

  const resolved = await resolveDriverIdForInvoice(supabase, invoice);
  if (!resolved) return invoice;

  const { data: driverExists } = await supabase
    .from("drivers")
    .select("id")
    .eq("id", resolved)
    .maybeSingle();

  if (!driverExists) {
    log("driver_id_unresolved_missing_row", { invoiceId: invoice.id, driverId: resolved });
    return { ...invoice, driver_id: resolved };
  }

  log("driver_id_recovered", { invoiceId: invoice.id, driverId: resolved });
  const { data: updated } = await supabase
    .from("invoices")
    .update({ driver_id: resolved })
    .eq("id", invoice.id as string)
    .select("*")
    .maybeSingle();

  return updated ?? { ...invoice, driver_id: resolved };
}

function formatDriverDisplayName(
  driver: Record<string, unknown>,
  profileFullName?: string | null,
): string {
  const fromDriver = `${driver.first_name ?? ""} ${driver.last_name ?? ""}`.trim();
  if (fromDriver) return fromDriver;
  const fromProfile = profileFullName?.trim();
  if (fromProfile) return fromProfile;
  if (driver.driver_code) return String(driver.driver_code);
  if (driver.id) return `Driver ${String(driver.id).slice(0, 8)}`;
  return "Driver";
}

async function loadDriverForInvoice(
  supabase: SupabaseClient,
  invoice: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const hydrated = await hydrateInvoiceDriverId(supabase, invoice);
  let driverId = isValidUuid(hydrated.driver_id) ? (hydrated.driver_id as string) : null;
  if (!driverId) {
    driverId = await resolveDriverIdForInvoice(supabase, hydrated);
  }
  if (!driverId) {
    const snapshotName = safeText(invoice.driver_display_name as string | undefined, "");
    if (snapshotName) {
      return {
        driver_code: invoice.driver_display_code,
        first_name: snapshotName,
        last_name: "",
      };
    }
    return {};
  }

  const { data: driver } = await supabase
    .from("drivers")
    .select("id, user_id, first_name, last_name, driver_code, email")
    .eq("id", driverId)
    .maybeSingle();
  if (!driver) {
    const snapshotEmail = safeText(hydrated.driver_display_email as string | undefined, "");
    return {
      id: driverId,
      email: snapshotEmail || undefined,
      first_name: hydrated.driver_display_name,
      driver_code: hydrated.driver_display_code,
    };
  }

  const fromDriver = `${driver.first_name ?? ""} ${driver.last_name ?? ""}`.trim();
  if (fromDriver) return driver;

  if (driver.user_id) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("full_name")
      .eq("user_id", driver.user_id)
      .maybeSingle();
    const fullName = profile?.full_name?.trim();
    if (fullName) {
      const [firstName, ...rest] = fullName.split(/\s+/);
      return {
        ...driver,
        first_name: firstName,
        last_name: rest.join(" "),
      };
    }
  }

  return driver;
}

async function persistDriverDisplayFields(
  supabase: SupabaseClient,
  invoice: Record<string, unknown>,
  driver: Record<string, unknown>,
): Promise<void> {
  const invoiceId = invoice.id as string | undefined;
  if (!invoiceId) return;

  const displayName = (() => {
    const fromDriver = formatDriverDisplayName(driver);
    if (fromDriver !== "Driver") return fromDriver;
    return safeText(invoice.driver_display_name as string | undefined, "");
  })();
  const displayCode = driver.driver_code
    ? String(driver.driver_code)
    : safeText(invoice.driver_display_code as string | undefined, "") || null;
  if (!displayName && !displayCode) return;

  const displayEmail = await resolveDriverRecipientEmail(supabase, driver, invoice);

  await supabase
    .from("invoices")
    .update({
      driver_display_name: displayName || null,
      driver_display_code: displayCode,
      driver_display_email: displayEmail,
    })
    .eq("id", invoiceId);
}

async function resolveDriverRecipientEmail(
  supabase: SupabaseClient,
  driver: Record<string, unknown>,
  invoice?: Record<string, unknown>,
): Promise<string | null> {
  const direct = safeText(driver.email as string | undefined, "");
  if (direct) return direct;

  const snapshot = safeText(invoice?.driver_display_email as string | undefined, "");
  if (snapshot) return snapshot;

  const userId = driver.user_id as string | undefined;
  if (userId) {
    const { data, error } = await supabase.auth.admin.getUserById(userId);
    if (!error && data?.user?.email) return data.user.email;
  }

  return null;
}

async function snapshotDriverFieldsForInsert(
  supabase: SupabaseClient,
  driverId: string,
): Promise<{
  driver_display_name: string | null;
  driver_display_code: string | null;
  driver_display_email: string | null;
}> {
  const { data: driver } = await supabase
    .from("drivers")
    .select("first_name, last_name, driver_code, email, user_id")
    .eq("id", driverId)
    .maybeSingle();

  if (!driver) {
    return { driver_display_name: null, driver_display_code: null, driver_display_email: null };
  }

  let displayName = `${driver.first_name ?? ""} ${driver.last_name ?? ""}`.trim();
  if (!displayName && driver.user_id) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("full_name")
      .eq("user_id", driver.user_id)
      .maybeSingle();
    displayName = profile?.full_name?.trim() || "";
  }

  const displayEmail = await resolveDriverRecipientEmail(supabase, driver);

  return {
    driver_display_name: displayName || null,
    driver_display_code: driver.driver_code ?? null,
    driver_display_email: displayEmail,
  };
}

async function relinkOrphanInvoiceDriver(
  supabase: SupabaseClient,
  invoice: Record<string, unknown>,
  overrideDriverId?: string | null,
): Promise<Record<string, unknown>> {
  const hydrated = await hydrateInvoiceDriverId(supabase, invoice);
  const resolvedId = isValidUuid(hydrated.driver_id)
    ? (hydrated.driver_id as string)
    : await resolveDriverIdForInvoice(supabase, hydrated);

  if (isValidUuid(resolvedId)) {
    const { data: existingDriver } = await supabase
      .from("drivers")
      .select("id")
      .eq("id", resolvedId)
      .maybeSingle();
    if (existingDriver) return hydrated;
  }

  let replacementId = isValidUuid(overrideDriverId) ? overrideDriverId : null;
  if (!replacementId && invoice.region_id) {
    const { data: regionDrivers } = await supabase
      .from("drivers")
      .select("id")
      .eq("region_id", invoice.region_id as string)
      .eq("driver_status", "active");
    if ((regionDrivers ?? []).length === 1) {
      replacementId = regionDrivers![0].id as string;
    }
  }

  if (!replacementId) return hydrated;

  const snapshot = await snapshotDriverFieldsForInsert(supabase, replacementId);
  const { data: periodConflict } = await supabase
    .from("invoices")
    .select("id")
    .eq("driver_id", replacementId)
    .eq("region_id", invoice.region_id as string)
    .eq("period_start", invoice.period_start as string)
    .eq("period_end", invoice.period_end as string)
    .neq("id", invoice.id as string)
    .not("status", "eq", "cancelled")
    .maybeSingle();

  if (periodConflict) {
    log("invoice_driver_snapshot_only", {
      invoiceId: invoice.id,
      replacementDriverId: replacementId,
      reason: "driver_period_conflict",
    });
    const { data: snapshotted } = await supabase
      .from("invoices")
      .update({
        driver_display_name: snapshot.driver_display_name,
        driver_display_code: snapshot.driver_display_code,
        driver_display_email: snapshot.driver_display_email,
      })
      .eq("id", invoice.id as string)
      .select("*")
      .maybeSingle();
    return {
      ...(snapshotted ?? hydrated),
      driver_id: replacementId,
      ...snapshot,
    };
  }

  log("invoice_driver_relinked", {
    invoiceId: invoice.id,
    previousDriverId: resolvedId,
    replacementDriverId: replacementId,
  });

  const { data: updated } = await supabase
    .from("invoices")
    .update({
      driver_id: replacementId,
      driver_display_name: snapshot.driver_display_name,
      driver_display_code: snapshot.driver_display_code,
      driver_display_email: snapshot.driver_display_email,
    })
    .eq("id", invoice.id as string)
    .select("*")
    .maybeSingle();

  return updated ?? { ...hydrated, driver_id: replacementId, ...snapshot };
}

function isModernBrandedPdfPath(path: string): boolean {
  return path.startsWith("invoices/drivers/") || path.startsWith("invoices/by-id/");
}

function candidatePdfLocations(invoice: Record<string, unknown>): Array<{ bucket: string; path: string }> {
  const driverId = isValidUuid(invoice.driver_id) ? (invoice.driver_id as string) : null;
  const invoiceId = invoice.id as string;
  const invoiceNo = invoice.invoice_number as string;
  const stored = invoice.pdf_storage_path as string | null;
  const modern: Array<{ bucket: string; path: string }> = [];
  const legacy: Array<{ bucket: string; path: string }> = [];

  const canonicalPath = resolvePdfStoragePath(invoice, driverId);
  modern.push({ bucket: BUCKET, path: canonicalPath });

  if (stored && stored !== canonicalPath) {
    if (isModernBrandedPdfPath(stored)) {
      modern.unshift({ bucket: BUCKET, path: stored });
    } else {
      legacy.push({ bucket: LEGACY_BUCKET, path: stored });
      legacy.push({ bucket: BUCKET, path: stored });
    }
  }

  if (driverId) {
    legacy.push({ bucket: LEGACY_BUCKET, path: `${driverId}/${invoiceId}.pdf` });
    legacy.push({ bucket: LEGACY_BUCKET, path: `${driverId}/${invoiceId}/ONECAB_Driver_Invoice_${invoiceNo}.pdf` });
    legacy.push({ bucket: BUCKET, path: `${driverId}/${invoiceId}/ONECAB_Driver_Invoice_${invoiceNo}.pdf` });
  }

  const seen = new Set<string>();
  return [...modern, ...legacy].filter(({ bucket, path }) => {
    if (!path) return false;
    const key = `${bucket}:${path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function existingPdfNeedsRegeneration(
  supabase: SupabaseClient,
  location: { bucket: string; path: string },
): Promise<boolean> {
  if (location.bucket === LEGACY_BUCKET) return true;
  if (!isModernBrandedPdfPath(location.path)) return true;

  const { data, error } = await supabase.storage.from(location.bucket).download(location.path);
  if (error || !data) return true;

  const bytes = new Uint8Array(await data.arrayBuffer());
  return !isBrandedDriverInvoicePdf(bytes);
}

async function findExistingPdfLocation(
  supabase: SupabaseClient,
  invoice: Record<string, unknown>,
  options: { allowLegacy?: boolean } = {},
): Promise<{ bucket: string; path: string } | null> {
  for (const location of candidatePdfLocations(invoice)) {
    if (!options.allowLegacy && location.bucket === LEGACY_BUCKET) continue;

    const { data, error } = await supabase.storage.from(location.bucket).download(location.path);
    if (error || !data) continue;

    const bytes = new Uint8Array(await data.arrayBuffer());
    if (!isBrandedDriverInvoicePdf(bytes)) continue;

    return location;
  }
  return null;
}

async function downloadInvoicePdfBytes(
  supabase: SupabaseClient,
  invoice: Record<string, unknown>,
): Promise<{ bytes: Uint8Array; bucket: string; path: string }> {
  const existing = await findExistingPdfLocation(supabase, invoice);
  if (existing) {
    const { data, error } = await supabase.storage.from(existing.bucket).download(existing.path);
    if (!error && data) {
      return {
        bytes: new Uint8Array(await data.arrayBuffer()),
        bucket: existing.bucket,
        path: existing.path,
      };
    }
  }

  const generated = await generatePdfForInvoice(supabase, invoice);
  const { data, error } = await supabase.storage.from(BUCKET).download(generated.pdfPath);
  if (error || !data) {
    throw new Error(error?.message ?? "PDF download failed after generation");
  }

  return {
    bytes: new Uint8Array(await data.arrayBuffer()),
    bucket: BUCKET,
    path: generated.pdfPath,
  };
}

async function insertDeliveryLog(
  supabase: SupabaseClient,
  payload: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase.from("invoice_delivery_logs").insert(payload);
  if (error) {
    console.warn("[DRIVER_INVOICE] delivery_log_failed", error.message);
  }
}

function normalizeAction(action: string): DriverInvoiceAction {
  if (action === "send") return "send_email";
  if (action === "resend") return "resend_email";
  return action as DriverInvoiceAction;
}

function nextMonthStart(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 1));
  return d.toISOString().slice(0, 10);
}

function toResponse(
  invoice: Record<string, unknown>,
  extra: Partial<DriverInvoiceResponse> = {},
): DriverInvoiceResponse {
  return {
    success: extra.success ?? true,
    ok: extra.success !== false,
    invoiceNo: (invoice.invoice_number as string) ?? extra.invoiceNo,
    invoice_id: (invoice.id as string) ?? extra.invoice_id,
    pdfUrl: extra.pdfUrl ?? extra.pdf_url ?? (invoice.invoice_pdf_url as string | undefined),
    pdf_url: extra.pdf_url ?? extra.pdfUrl ?? (invoice.invoice_pdf_url as string | undefined),
    emailStatus: (invoice.invoice_email_status as string | null) ?? extra.emailStatus,
    ...extra,
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function safeText(value: unknown, fallback = "—"): string {
  if (value == null) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function formatPeriod(start: unknown, end: unknown): string {
  const startText = safeText(start, "");
  const endText = safeText(end, "");
  if (!startText || !endText) return "—";
  return `${startText} – ${endText}`;
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
    { description: "Airport Fee Earnings", trips: 0, amountPence: Number(invoice.airport_fee_earnings_pence ?? 0) },
    { description: "Extra Charge Earnings", trips: 0, amountPence: Number(invoice.extra_charge_earnings_pence ?? 0) },
    { description: "Bonuses", trips: 0, amountPence: Number(invoice.bonuses_pence ?? 0) },
    { description: "Adjustments", trips: 0, amountPence: Number(invoice.adjustments_pence ?? 0) },
    { description: "Platform Commission", trips: 0, amountPence: Number(invoice.commission_pence ?? 0), isDeduction: true },
  ];

  const branding = companyBranding.branding;

  return {
    invoiceNo: safeText(invoice.invoice_number, "INVOICE"),
    invoiceTitle: safeText(template?.invoice_title, "Driver Earnings Statement"),
    driverName: (() => {
      const fromDriver = formatDriverDisplayName(driver);
      if (fromDriver !== "Driver") return fromDriver;
      return safeText(invoice.driver_display_name as string | undefined, "Driver");
    })(),
    driverId: safeText(
      driver.driver_code ?? invoice.driver_display_code ?? driver.id ?? invoice.driver_id,
      "—",
    ),
    regionName: safeText(region?.name, "—"),
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
      address: formatCompanyAddress({
        ...companyBranding.company,
        address: companyBranding.company.address || (template?.company_address as string) || "",
      }) || companyBranding.company.address || (template?.company_address as string) || "",
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
  const hydrated = await hydrateInvoiceDriverId(supabase, invoice);
  const driverId = isValidUuid(hydrated.driver_id) ? (hydrated.driver_id as string) : null;
  const driver = await loadDriverForInvoice(supabase, hydrated);
  await persistDriverDisplayFields(supabase, hydrated, driver);

  const { data: region } = await supabase
    .from("regions")
    .select("name")
    .eq("id", hydrated.region_id)
    .maybeSingle();

  const companyBranding = await fetchCompanyBranding(supabase);
  const template = await loadTemplate(supabase);
  const renderData = buildRenderData(hydrated, driver ?? {}, region, companyBranding, template);
  const html = await prepareDriverInvoiceHtmlForPdf(renderData);
  const pdfBytes = await buildDriverInvoicePdf(renderData);
  const storagePath = resolvePdfStoragePath(hydrated, driverId);
  log("pdf_generation_started", {
    driverId,
    invoiceNo: invoice.invoice_number,
    storagePath,
  });

  const { error: uploadErr } = await supabase.storage.from(BUCKET).upload(storagePath, pdfBytes, {
    contentType: "application/pdf",
    upsert: true,
  });
  if (uploadErr) throw new Error(`PDF upload failed: ${uploadErr.message}`);
  log("pdf_uploaded", { storagePath, driverId: invoice.driver_id, invoiceNo: invoice.invoice_number });

  const { error: htmlUploadErr } = await supabase.storage.from(BUCKET).upload(
    storagePath.replace(/\.pdf$/, ".html"),
    new TextEncoder().encode(html),
    { contentType: "text/html", upsert: true },
  );
  if (htmlUploadErr) {
    console.warn("[DRIVER_INVOICE] html_upload_failed", htmlUploadErr.message);
  }

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
  if (!isValidUuid(params.driverId)) {
    return { ok: false, error: "Invoice is missing a valid driver. Cannot regenerate without a linked driver." };
  }

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
    const driverSnapshot = await snapshotDriverFieldsForInsert(supabase, params.driverId);
    const { data: created, error: insertErr } = await supabase
      .from("invoices")
      .insert({
        invoice_number: invoiceNumber,
        driver_id: params.driverId,
        driver_display_name: driverSnapshot.driver_display_name,
        driver_display_code: driverSnapshot.driver_display_code,
        driver_display_email: driverSnapshot.driver_display_email,
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
  options: { overrideDriverId?: string } = {},
): Promise<{ ok: boolean; error?: string }> {
  const { data: invoice } = await supabase.from("invoices").select("*").eq("id", invoiceId).single();
  if (!invoice) return { ok: false, error: "Invoice not found" };
  if (invoice.invoice_email_sent && !forceResend) return { ok: true };

  const relinked = await relinkOrphanInvoiceDriver(
    supabase,
    invoice,
    options.overrideDriverId ?? null,
  );
  const hydrated = await hydrateInvoiceDriverId(supabase, relinked);
  const driver = await loadDriverForInvoice(supabase, hydrated);
  await persistDriverDisplayFields(supabase, hydrated, driver);

  const recipientEmail = await resolveDriverRecipientEmail(supabase, driver, hydrated);
  if (!recipientEmail) {
    const message = isValidUuid(hydrated.driver_id)
      ? "Driver email not found. Update the driver profile email or regenerate this invoice for an active driver."
      : "Invoice has no linked driver. Regenerate the statement for an active driver before sending email.";
    await supabase.from("invoices").update({
      invoice_email_sent: false,
      invoice_email_status: "failed",
      invoice_email_error: message,
    }).eq("id", invoiceId);
    return { ok: false, error: message };
  }

  let pdfPath = hydrated.pdf_storage_path as string | null;
  let pdfBytes: Uint8Array;
  try {
    const downloaded = await downloadInvoicePdfBytes(supabase, hydrated);
    pdfBytes = downloaded.bytes;
    pdfPath = downloaded.path;
    if (invoice.pdf_storage_path !== downloaded.path || !invoice.invoice_generated_at) {
      const { data: signed } = await supabase.storage
        .from(downloaded.bucket)
        .createSignedUrl(downloaded.path, 60 * 60 * 24 * 365);
      await supabase.from("invoices").update({
        pdf_storage_path: downloaded.path,
        invoice_pdf_url: signed?.signedUrl ?? invoice.invoice_pdf_url,
        invoice_generated_at: invoice.invoice_generated_at ?? new Date().toISOString(),
      }).eq("id", invoiceId);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await supabase.from("invoices").update({
      invoice_email_sent: false,
      invoice_email_status: "failed",
      invoice_email_error: message,
    }).eq("id", invoiceId);
    return { ok: false, error: message };
  }

  const companyBranding = await fetchCompanyBranding(supabase);
  const template = await loadTemplate(supabase);

  const email = buildDriverInvoiceEmail({
    driverName: formatDriverDisplayName(driver, hydrated.driver_display_name as string | undefined),
    invoiceNo: invoice.invoice_number,
    invoicePeriod: formatPeriod(invoice.period_start, invoice.period_end),
    companyPhone: companyBranding.company.phone,
    companyEmail: companyBranding.company.email,
    companyWebsite: companyBranding.company.website,
    logoUrl: companyBranding.branding.logoUrl,
  });

  const invoiceNo = safeText(invoice.invoice_number, "INVOICE");
  const subjectTemplate = safeText(
    template?.email_subject ?? email.subject,
    `Your ONECAB Driver Statement - ${invoiceNo}`,
  );
  const subject = subjectTemplate
    .replace(/\{\{invoiceNo\}\}/g, invoiceNo)
    .replace(/\{\{invoice_number\}\}/g, invoiceNo);

  const fromAddress = formatResendFromAddress(
    companyBranding.company.name || companyBranding.company.legalName,
    companyBranding.company.email,
  );

  log("email_sending_started", { invoiceId, to: recipientEmail, invoiceNo: invoice.invoice_number });
  const sendResult = await sendResendEmail({
    to: recipientEmail,
    subject,
    html: email.html,
    text: email.text,
    from: fromAddress,
    replyTo: companyBranding.company.email || undefined,
    attachments: [{
      filename: `ONECAB_Driver_Invoice_${safeText(invoice.invoice_number, "INVOICE")}.pdf`,
      content: bytesToBase64(pdfBytes),
      contentType: "application/pdf",
    }],
    tag: "driver_monthly_invoice",
  });

  const now = new Date().toISOString();
  if (!sendResult.ok) {
    log("email_failed", { invoiceId, error: sendResult.message });
    await supabase.from("invoices").update({
      invoice_email_sent: false,
      invoice_email_status: "failed",
      invoice_email_error: sendResult.message,
    }).eq("id", invoiceId);
    await insertDeliveryLog(supabase, {
      invoice_id: invoiceId,
      sent_to_email: recipientEmail,
      delivery_status: "failed",
      error_message: sendResult.message,
    });
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

  await insertDeliveryLog(supabase, {
    invoice_id: invoiceId,
    sent_to_email: recipientEmail,
    delivery_status: "sent",
    sent_at: now,
  });

  log("email_sent", { invoiceId, invoiceNo: invoice.invoice_number, to: recipientEmail });
  return { ok: true };
}

export async function previewDriverInvoiceHtml(
  supabase: SupabaseClient,
  invoiceId: string,
): Promise<{ html?: string; error?: string }> {
  const { data: invoice } = await supabase.from("invoices").select("*").eq("id", invoiceId).single();
  if (!invoice) return { error: "Invoice not found" };

  const hydrated = await hydrateInvoiceDriverId(supabase, invoice);
  const driver = await loadDriverForInvoice(supabase, hydrated);
  const { data: region } = await supabase.from("regions").select("name").eq("id", invoice.region_id).maybeSingle();
  const companyBranding = await fetchCompanyBranding(supabase);
  const template = await loadTemplate(supabase);
  return { html: buildDriverInvoiceHtml(buildRenderData(hydrated, driver ?? {}, region, companyBranding, template)) };
}

async function getSignedUrls(
  supabase: SupabaseClient,
  storagePath: string | null | undefined,
  bucket = BUCKET,
  options: { invoiceNo?: string; mode?: "view" | "download" } = {},
): Promise<{ pdf_url?: string }> {
  if (!storagePath) return {};
  const invoiceNo = options.invoiceNo ?? storagePath.replace(/.*\//, "").replace(/\.pdf$/, "");
  const signedOptions = options.mode === "download"
    ? { download: `ONECAB_Driver_Invoice_${invoiceNo}.pdf` }
    : undefined;

  const { data: pdfSigned, error: pdfErr } = await supabase.storage
    .from(bucket)
    .createSignedUrl(storagePath, 60 * 60, signedOptions);

  if (pdfErr) {
    log("signed_url_failed", { storagePath, bucket, error: pdfErr.message });
  }

  return { pdf_url: pdfSigned?.signedUrl };
}

async function resolveInvoice(
  supabase: SupabaseClient,
  body: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const invoiceId = (body.invoice_id ?? body.invoiceId) as string | undefined;
  if (invoiceId) {
    const { data } = await supabase.from("invoices").select("*").eq("id", invoiceId).maybeSingle();
    return data;
  }

  const driverId = (body.driverId ?? body.driver_id) as string | undefined;
  const invoiceMonth = (body.invoiceMonth ?? body.invoice_month) as string | undefined;
  if (!isValidUuid(driverId) || !invoiceMonth) return null;

  const monthStart = `${invoiceMonth}-01`;
  const monthEnd = nextMonthStart(invoiceMonth);
  const { data } = await supabase
    .from("invoices")
    .select("*")
    .eq("driver_id", driverId)
    .gte("period_start", monthStart)
    .lt("period_start", monthEnd)
    .not("status", "eq", "cancelled")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return data;
}

export async function generateDriverInvoicePdfOnly(
  supabase: SupabaseClient,
  invoiceId: string,
): Promise<{ ok: boolean; error?: string }> {
  const { data: invoice } = await supabase.from("invoices").select("*").eq("id", invoiceId).single();
  if (!invoice) return { ok: false, error: "Invoice not found" };

  try {
    const { pdfPath, pdfUrl } = await generatePdfForInvoice(supabase, invoice);
    const now = new Date().toISOString();
    await supabase.from("invoices").update({
      pdf_storage_path: pdfPath,
      invoice_pdf_url: pdfUrl,
      invoice_generated_at: now,
      invoice_pdf_error: null,
      finalized_at: invoice.finalized_at ?? now,
      status: invoice.status === "draft" ? "finalized" : invoice.status,
    }).eq("id", invoiceId);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await supabase.from("invoices").update({ invoice_pdf_error: message }).eq("id", invoiceId);
    return { ok: false, error: message };
  }
}

async function ensurePdf(
  supabase: SupabaseClient,
  invoice: Record<string, unknown>,
  regenerate: boolean,
): Promise<Record<string, unknown> & { _pdf_bucket?: string }> {
  if (!regenerate) {
    const existing = await findExistingPdfLocation(supabase, invoice);
    if (existing) {
      const needsRefresh = await existingPdfNeedsRegeneration(supabase, existing);
      if (!needsRefresh) {
        const urls = await getSignedUrls(supabase, existing.path, existing.bucket, {
          invoiceNo: invoice.invoice_number as string,
          mode: "view",
        });
        log("invoice_found", {
          invoiceId: invoice.id,
          driverId: invoice.driver_id,
          invoiceNo: invoice.invoice_number,
          pdfExists: true,
          bucket: existing.bucket,
          path: existing.path,
        });
        return {
          ...invoice,
          pdf_storage_path: existing.path,
          invoice_pdf_url: urls.pdf_url ?? invoice.invoice_pdf_url,
          _pdf_bucket: existing.bucket,
        };
      }
      log("pdf_regeneration_required", {
        invoiceId: invoice.id,
        reason: "stale_or_unbranded_pdf",
        path: existing.path,
        bucket: existing.bucket,
      });
    }
  }

  log("pdf_generation_started", {
    invoiceId: invoice.id,
    driverId: invoice.driver_id,
    invoiceNo: invoice.invoice_number,
    regenerate,
  });

  const { pdfPath, pdfUrl } = await generatePdfForInvoice(supabase, invoice);
  const now = new Date().toISOString();
  const { data: updated } = await supabase
    .from("invoices")
    .update({
      pdf_storage_path: pdfPath,
      invoice_pdf_url: pdfUrl,
      invoice_generated_at: now,
      invoice_pdf_error: null,
      finalized_at: invoice.finalized_at ?? now,
      status: invoice.status === "draft" ? "finalized" : invoice.status,
    })
    .eq("id", invoice.id)
    .select("*")
    .single();

  log("invoice_updated", {
    invoiceId: invoice.id,
    pdfPath,
    invoiceNo: invoice.invoice_number,
  });

  return {
    ...(updated ?? { ...invoice, pdf_storage_path: pdfPath, invoice_pdf_url: pdfUrl, invoice_generated_at: now }),
    _pdf_bucket: BUCKET,
  };
}

export async function handleDriverInvoiceAction(
  supabase: SupabaseClient,
  body: Record<string, unknown>,
  rawAction: DriverInvoiceAction = "generate",
): Promise<DriverInvoiceResponse> {
  const action = normalizeAction(rawAction);
  const driverId = (body.driverId ?? body.driver_id) as string | undefined;
  const invoiceMonth = (body.invoiceMonth ?? body.invoice_month) as string | undefined;

  log("received", { action: rawAction, normalized: action, driverId, invoiceMonth, invoice_id: body.invoice_id });

  if (action === "generate") {
    if (!body.driver_id && !body.driverId) {
      return { success: false, ok: false, error: "Missing driverId" };
    }
    if (!body.period_start || !body.period_end) {
      return { success: false, ok: false, error: "Missing invoice period (period_start / period_end)" };
    }
    if (!body.region_id) {
      return { success: false, ok: false, error: "Missing region_id" };
    }

    const result = await generateDriverInvoice(supabase, {
      driverId: (body.driver_id ?? body.driverId) as string,
      periodStart: body.period_start as string,
      periodEnd: body.period_end as string,
      regionId: body.region_id as string,
      serviceAreaId: body.service_area_id as string | null | undefined,
    });

    if (!result.ok) {
      log("generate_failed", { error: result.error, driverId: body.driver_id ?? body.driverId });
      return { success: false, ok: false, error: result.error, invoice_id: result.invoice_id };
    }

    const invoice = await supabase.from("invoices").select("*").eq("id", result.invoice_id!).single();
    if (invoice.error || !invoice.data) {
      return { success: false, ok: false, error: "Invoice created but not found" };
    }

    log("invoice_created", { invoiceId: result.invoice_id, invoiceNo: invoice.data.invoice_number });
    return toResponse(invoice.data, {
      success: true,
      message: "Invoice PDF generated successfully",
      pdfUrl: invoice.data.invoice_pdf_url as string,
      pdf_url: invoice.data.invoice_pdf_url as string,
    });
  }

  const resolved = await resolveInvoice(supabase, body);
  if (!resolved) {
    const missing: string[] = [];
    if (!body.invoice_id && !body.invoiceId) missing.push("invoice_id or driverId+invoiceMonth");
    log("invoice_not_found", { driverId, invoiceMonth, missing });
    return {
      success: false,
      ok: false,
      error: `Invoice not found — provide ${missing.join(" and ") || "invoice_id or driverId+invoiceMonth"}`,
    };
  }

  const invoice = await hydrateInvoiceDriverId(supabase, resolved);

  log("invoice_found", {
    invoiceId: invoice.id,
    driverId: invoice.driver_id,
    invoiceNo: invoice.invoice_number,
  });

  try {
    if (action === "regenerate") {
      const aggRegion = invoice.region_id as string;
      const regenDriverId = invoice.driver_id as string;
      let updated = invoice;

      if (isValidUuid(regenDriverId)) {
        const regen = await generateDriverInvoice(supabase, {
          driverId: regenDriverId,
          periodStart: invoice.period_start as string,
          periodEnd: invoice.period_end as string,
          regionId: aggRegion,
          serviceAreaId: invoice.service_area_id as string | null,
          regenerateInvoiceId: invoice.id as string,
        });
        if (!regen.ok) {
          return { success: false, ok: false, error: regen.error, invoice_id: invoice.id as string };
        }
        const refreshed = await supabase.from("invoices").select("*").eq("id", invoice.id).single();
        updated = refreshed.data ?? invoice;
      } else {
        log("regenerate_pdf_only", { invoiceId: invoice.id, reason: "missing_driver_id" });
      }

      const withPdf = await ensurePdf(supabase, updated, true);
      const storagePath = withPdf.pdf_storage_path as string | undefined;
      const bucket = (withPdf as { _pdf_bucket?: string })._pdf_bucket ?? BUCKET;
      const urls = storagePath
        ? await getSignedUrls(supabase, storagePath, bucket, {
          invoiceNo: withPdf.invoice_number as string,
          mode: "view",
        })
        : {};
      return toResponse(withPdf, {
        success: true,
        message: "Invoice PDF regenerated",
        pdfUrl: urls.pdf_url ?? (withPdf.invoice_pdf_url as string),
        pdf_url: urls.pdf_url,
      });
    }

    if (action === "download" || action === "view") {
      const updated = await ensurePdf(supabase, invoice, false);
      const storagePath = updated.pdf_storage_path as string;
      if (!storagePath) {
        return {
          success: false,
          ok: false,
          stage: "pdf_generation",
          error: "Failed to generate invoice PDF",
          invoice_id: invoice.id as string,
        };
      }
      const bucket = (updated as { _pdf_bucket?: string })._pdf_bucket ?? BUCKET;
      const urls = await getSignedUrls(supabase, storagePath, bucket, {
        invoiceNo: updated.invoice_number as string,
        mode: action === "download" ? "download" : "view",
      });
      const pdfUrl = urls.pdf_url ?? (updated.invoice_pdf_url as string);
      if (!pdfUrl) {
        return {
          success: false,
          ok: false,
          stage: "pdf_generation",
          error: "Invoice PDF URL could not be created",
          invoice_id: invoice.id as string,
        };
      }
      return toResponse(updated, {
        success: true,
        pdfUrl,
        pdf_url: pdfUrl,
        message: action === "download" ? "Invoice PDF ready" : "Invoice ready to view",
      });
    }

    if (action === "send_email" || action === "resend_email") {
      log("email_sending_started", { invoiceId: invoice.id, action });
      await ensurePdf(supabase, invoice, false);
      const relinkedForSend = await relinkOrphanInvoiceDriver(
        supabase,
        invoice,
        (body.driver_id ?? body.driverId) as string | undefined,
      );
      const emailResult = await sendDriverInvoiceEmail(
        supabase,
        relinkedForSend.id as string,
        action === "resend_email",
        { overrideDriverId: (body.driver_id ?? body.driverId) as string | undefined },
      );
      if (!emailResult.ok) {
        log("email_failed", { invoiceId: invoice.id, error: emailResult.error });
        return {
          success: false,
          ok: false,
          stage: "email_sending",
          error: emailResult.error ?? "Email send failed",
          invoice_id: invoice.id as string,
          invoiceNo: invoice.invoice_number as string,
        };
      }
      log("email_sent", { invoiceId: invoice.id, invoiceNo: invoice.invoice_number });
      const { data: refreshed } = await supabase.from("invoices").select("*").eq("id", invoice.id).single();
      return toResponse(refreshed ?? invoice, {
        success: true,
        emailStatus: "sent",
        message: "Invoice email sent successfully",
      });
    }

    return { success: false, ok: false, error: `Unsupported action: ${action}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log("action_error", { action, invoiceId: invoice.id, error: message });
    return { success: false, ok: false, error: message, invoice_id: invoice.id as string };
  }
}

export async function getDriverInvoiceUrls(
  supabase: SupabaseClient,
  invoiceId: string,
): Promise<DriverInvoiceResponse> {
  return handleDriverInvoiceAction(supabase, { invoice_id: invoiceId }, "download");
}
