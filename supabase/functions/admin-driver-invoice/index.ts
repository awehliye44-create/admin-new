import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, requireAdminOrStaff } from "../_shared/adminPaymentGate.ts";
import {
  handleDriverInvoiceAction,
  previewDriverInvoiceHtml,
  type DriverInvoiceAction,
  type DriverInvoiceResponse,
} from "../_shared/driverInvoiceService.ts";

const VALID_ACTIONS = new Set<DriverInvoiceAction>([
  "generate",
  "regenerate",
  "view",
  "download",
  "send_email",
  "resend_email",
  "send",
  "resend",
  "preview",
]);

function jsonOk(body: DriverInvoiceResponse | Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function jsonFail(error: string, extra: Partial<DriverInvoiceResponse> = {}): Response {
  return jsonOk({ success: false, ok: false, error, ...extra });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonFail("Method not allowed");
  }

  try {
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return jsonFail("Invalid JSON body");
    }

    const action = (body.action ?? "generate") as DriverInvoiceAction;
    const driverId = (body.driverId ?? body.driver_id) as string | undefined;
    const invoiceMonth = (body.invoiceMonth ?? body.invoice_month) as string | undefined;

    console.log("[DRIVER_INVOICE]", JSON.stringify({
      step: "request",
      action,
      driverId,
      invoiceMonth,
      invoice_id: body.invoice_id,
      get_urls: body.get_urls ?? false,
    }));

    const gate = await requireAdminOrStaff(req);
    if (!gate.ok) {
      const errBody = await gate.response.json().catch(() => ({ error: "Unauthorized" }));
      return jsonFail(errBody.error ?? "Unauthorized");
    }

    const supabase = gate.supabase;

    if (body.get_urls && body.invoice_id) {
      const result = await handleDriverInvoiceAction(supabase, body, "download");
      return jsonOk(result);
    }

    if (action === "preview") {
      if (body.sample) {
        const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
        const service = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey);
        const brandingModule = await import("../_shared/companyBranding.ts");
        const companyBranding = await brandingModule.fetchCompanyBranding(service);
        const { prepareDriverInvoiceHtmlForPdf } = await import("../_shared/driverInvoiceHtml.ts");

        const templateCompanyName = (body.company_name as string | undefined)?.trim();
        const templateAddress = (body.company_address as string | undefined)?.trim();

        const company = {
          ...companyBranding.company,
          name: templateCompanyName || companyBranding.company.name,
          legalName: templateCompanyName || companyBranding.company.legalName,
          email: (body.company_email as string | undefined)?.trim() || companyBranding.company.email,
          phone: (body.company_phone as string | undefined)?.trim() || companyBranding.company.phone,
          website: (body.company_website as string | undefined)?.trim() || companyBranding.company.website,
          address: templateAddress || brandingModule.formatCompanyAddress(companyBranding.company),
        };

        const branding = {
          ...companyBranding.branding,
          tagline: companyBranding.branding.tagline || "One App. Every Journey.",
        };

        const html = await prepareDriverInvoiceHtmlForPdf({
          invoiceNo: "INV-2606-001",
          invoiceTitle: (body.invoice_title as string) || "Driver Earnings Statement",
          driverName: "Sample Driver",
          driverId: "MK002",
          regionName: "UK1",
          currency: "GBP",
          invoicePeriod: "1 Apr 2026 – 30 Apr 2026",
          invoiceStatus: "Pending",
          generatedDate: new Date().toISOString().slice(0, 10),
          summaryRows: [
            { description: "Completed Card Trip Earnings", trips: 5, amountPence: 5200 },
            { description: "Completed Cash Trip Earnings", trips: 1, amountPence: 1380 },
            { description: "Airport Fee Earnings", trips: 0, amountPence: 0 },
            { description: "Extra Charge Earnings", trips: 0, amountPence: 0 },
            { description: "Bonuses", trips: 0, amountPence: 0 },
            { description: "Adjustments", trips: 0, amountPence: 0 },
            { description: "Platform Commission", trips: 0, amountPence: 342, isDeduction: true },
            { description: "Cash Collected (Offset)", trips: 0, amountPence: 1915, isDeduction: true },
          ],
          totalTrips: 6,
          cashTrips: 1,
          cardTrips: 5,
          grossEarningsPence: 6580,
          airportFeeEarningsPence: 0,
          extraChargeEarningsPence: 0,
          bonusesPence: 0,
          adjustmentsPence: 0,
          platformCommissionPence: 342,
          cashCollectedOffsetPence: 1915,
          netDriverEarningsPence: 4323,
          company,
          branding,
          footerText: (body.footer_text as string | undefined) || (body.notes_footer as string | undefined),
        });
        return jsonOk({ success: true, html });
      }

      if (!body.invoice_id) {
        return jsonFail("Missing invoice_id for preview");
      }

      const result = await previewDriverInvoiceHtml(supabase, body.invoice_id as string);
      if (result.error) {
        return jsonFail(result.error);
      }
      return jsonOk({ success: true, html: result.html });
    }

    if (!VALID_ACTIONS.has(action)) {
      return jsonFail(`Invalid action: ${action}`);
    }

    if (action !== "generate" && !body.invoice_id && !body.invoiceId && !(driverId && invoiceMonth)) {
      return jsonFail("Missing invoice_id or driverId+invoiceMonth");
    }

    const result = await handleDriverInvoiceAction(supabase, body, action);
    return jsonOk(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[DRIVER_INVOICE]", JSON.stringify({ step: "unhandled_error", error: message }));
    return jsonFail(message);
  }
});
