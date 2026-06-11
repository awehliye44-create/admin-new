import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, requireAdmin } from "../_shared/adminPaymentGate.ts";
import {
  generateDriverInvoice,
  getDriverInvoiceUrls,
  previewDriverInvoiceHtml,
  sendDriverInvoiceEmail,
  type DriverInvoiceAction,
} from "../_shared/driverInvoiceService.ts";

const VALID: Set<DriverInvoiceAction> = new Set(["generate", "regenerate", "send", "resend", "preview"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const gate = await requireAdmin(req);
    if (!gate.ok) return gate.response;

    const supabase = gate.supabase;
    const body = await req.json().catch(() => ({}));
    const action = (body.action ?? "generate") as DriverInvoiceAction;
    if (!VALID.has(action)) {
      return new Response(JSON.stringify({ error: "Invalid action" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (body.get_urls && body.invoice_id) {
      const urls = await getDriverInvoiceUrls(supabase, body.invoice_id);
      return new Response(JSON.stringify(urls), {
        status: urls.error ? 404 : 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "preview") {
      if (body.sample) {
        const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
        const service = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey);
        const companyBranding = await import("../_shared/companyBranding.ts").then((m) => m.fetchCompanyBranding(service));
        const { buildDriverInvoiceHtml } = await import("../_shared/driverInvoiceHtml.ts");
        const html = buildDriverInvoiceHtml({
          invoiceNo: "INV-2606-001",
          invoiceTitle: body.invoice_title || "Driver Earnings Statement",
          driverName: "Sample Driver",
          driverId: "MK-260610-001",
          regionName: "London",
          currency: "GBP",
          invoicePeriod: "01 Jun 2026 – 30 Jun 2026",
          invoiceStatus: "Pending",
          generatedDate: new Date().toISOString().slice(0, 10),
          summaryRows: [
            { description: "Completed Card Trip Earnings", trips: 42, amountPence: 125000 },
            { description: "Completed Cash Trip Earnings", trips: 8, amountPence: 18000 },
            { description: "Platform Commission", trips: 0, amountPence: 21500, isDeduction: true },
          ],
          totalTrips: 50,
          cashTrips: 8,
          cardTrips: 42,
          grossEarningsPence: 143000,
          airportFeeEarningsPence: 5000,
          extraChargeEarningsPence: 2000,
          bonusesPence: 1000,
          adjustmentsPence: 0,
          platformCommissionPence: 21500,
          cashCollectedOffsetPence: 3000,
          netDriverEarningsPence: 125500,
          company: companyBranding.company,
          branding: companyBranding.branding,
          footerText: body.footer_text,
        });
        return new Response(JSON.stringify({ html }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const result = await previewDriverInvoiceHtml(supabase, body.invoice_id);
      return new Response(JSON.stringify(result), {
        status: result.error ? 404 : 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "generate" || action === "regenerate") {
      const result = await generateDriverInvoice(supabase, {
        driverId: body.driver_id,
        periodStart: body.period_start,
        periodEnd: body.period_end,
        regionId: body.region_id,
        serviceAreaId: body.service_area_id,
        regenerateInvoiceId: action === "regenerate" ? body.invoice_id : undefined,
      });
      return new Response(JSON.stringify(result), {
        status: result.ok ? 200 : 422,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "send" || action === "resend") {
      const result = await sendDriverInvoiceEmail(supabase, body.invoice_id, action === "resend");
      return new Response(JSON.stringify(result), {
        status: result.ok ? 200 : 422,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Unsupported action" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
