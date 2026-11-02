/**
 * Thin security adapter: authorised passenger fare records for the signed-in driver.
 *
 * verify_jwt = false in config.toml (same pattern as sibling driver Edges) — this
 * function MUST authenticate via Authorization Bearer + auth.getUser() and enforce
 * ownership with driver_id from the JWT-linked drivers row (never from the client).
 *
 * Reuses existing trips fare columns with the same settlement priority as
 * `_shared/tripInvoice.ts` → getTripSettlementFarePence.
 * Does NOT generate PDFs, email riders, recalculate commission, mutate finance,
 * or expose PII (no passenger email/phone/payment credentials/invoice_pdf_url).
 */
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { extractDriverBearerToken } from "./authz.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const PDF_ACCESS_LIMITATION =
  "Passenger invoice PDFs are emailed to the rider only under ONECAB policy. Drivers can view authorised fare records and export CSV here; PDF download is not enabled.";

const SAFE_SELECT = [
  "id",
  "completed_at",
  "pickup_address",
  "payment_method",
  "payment_collection_model",
  "financial_model",
  "currency_code",
  "currency",
  "status",
  "invoice_total_paid_pence",
  "capture_amount_pence",
  "final_customer_fare_pence",
  "final_fare_pence",
  "gross_fare_pence",
  "invoice_no",
  "invoice_generated_at",
].join(",");

function settlementFarePence(trip: Record<string, unknown>): number {
  const candidates = [
    trip.invoice_total_paid_pence,
    trip.capture_amount_pence,
    trip.final_customer_fare_pence,
    trip.final_fare_pence,
    trip.gross_fare_pence,
  ];
  for (const value of candidates) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return Math.round(n);
  }
  return 0;
}

function unauthorized(message = "Unauthorized", status = 401): Response {
  return new Response(JSON.stringify({ success: false, error: message }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const bearer = extractDriverBearerToken(
      req.headers.get("Authorization"),
      anonKey,
      serviceKey,
    );
    if (!bearer.ok) {
      return unauthorized(bearer.error, 401);
    }

    const supabaseUser = createClient(
      Deno.env.get("SUPABASE_URL")!,
      anonKey!,
      { global: { headers: { Authorization: `Bearer ${bearer.token}` } } },
    );
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      serviceKey!,
    );

    const {
      data: { user },
      error: authError,
    } = await supabaseUser.auth.getUser();
    if (authError || !user) {
      return unauthorized("Unauthorized", 401);
    }

    // Ownership from JWT-linked driver row — ignore any client driver_id.
    const { data: driver, error: driverError } = await supabaseUser
      .from("drivers")
      .select("id")
      .eq("user_id", user.id)
      .single();

    if (driverError || !driver?.id) {
      return unauthorized("Driver not found", 403);
    }

    const body = req.method === "GET"
      ? Object.fromEntries(new URL(req.url).searchParams)
      : await req.json().catch(() => ({}));

    // Defence in depth — never honour client-supplied driver identity.
    if (body.driver_id != null || body.driverId != null) {
      return unauthorized("Invalid request", 400);
    }

    const yearMonth =
      typeof body.year_month === "string" && /^\d{4}-\d{2}$/.test(body.year_month.trim())
        ? body.year_month.trim()
        : null;
    const paymentMethod =
      typeof body.payment_method === "string" && body.payment_method.trim()
        ? body.payment_method.trim().toLowerCase()
        : null;

    const { data: trips, error: tripsError } = await supabaseAdmin
      .from("trips")
      .select(SAFE_SELECT)
      .eq("driver_id", driver.id)
      .eq("status", "completed")
      .not("completed_at", "is", null)
      .order("completed_at", { ascending: false })
      .limit(500);

    if (tripsError) throw tripsError;

    const rows = (trips ?? [])
      .map((trip) => {
        const fare = settlementFarePence(trip as Record<string, unknown>);
        const completedAt = typeof trip.completed_at === "string" ? trip.completed_at : null;
        const method =
          typeof trip.payment_method === "string" ? trip.payment_method.toLowerCase() : null;
        return {
          trip_id: trip.id as string,
          completed_at: completedAt,
          pickup_address: typeof trip.pickup_address === "string" ? trip.pickup_address : null,
          passenger_fare_pence: fare,
          currency_code:
            (typeof trip.currency_code === "string" && trip.currency_code) ||
            (typeof trip.currency === "string" && trip.currency) ||
            "GBP",
          payment_method: method,
          financial_model:
            typeof trip.financial_model === "string" ? trip.financial_model : null,
          payment_collection_model:
            typeof trip.payment_collection_model === "string"
              ? trip.payment_collection_model
              : null,
          invoice_no: typeof trip.invoice_no === "string" ? trip.invoice_no : null,
          invoice_available: Boolean(trip.invoice_no || trip.invoice_generated_at),
          pdf_download_authorised: false,
        };
      })
      .filter((row) => {
        if (yearMonth) {
          const key = row.completed_at ? row.completed_at.slice(0, 7) : null;
          if (key !== yearMonth) return false;
        }
        if (paymentMethod && row.payment_method !== paymentMethod) return false;
        return true;
      });

    return new Response(
      JSON.stringify({
        success: true,
        rows,
        pdf_access_limitation: PDF_ACCESS_LIMITATION,
        pdf_download_authorised: false,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("[driver-passenger-fare-records]", err);
    return new Response(
      JSON.stringify({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
