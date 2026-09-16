import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { corsHeaders, requireAdminOrStaff } from "../_shared/adminPaymentGate.ts";
import { handleTripInvoiceAction, type TripInvoiceAction } from "../_shared/tripInvoice.ts";

const VALID_ACTIONS = new Set<TripInvoiceAction>([
  "generate",
  "generate_only",
  "regenerate",
  "view",
  "download",
  "resend_email",
  "send_email",
]);

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function serviceClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

function isServiceRoleCall(req: Request): boolean {
  const key = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "").trim();
  const auth = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!auth) return false;
  if (key.length > 20 && auth === key) return true;
  // JWT service_role token (pg_cron vault token may differ from the env copy).
  try {
    const payload = JSON.parse(atob(auth.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return payload?.role === "service_role";
  } catch {
    return false;
  }
}


const SWEEP_LIMIT = 15;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ success: false, ok: false, error: "Method not allowed" }, 405);

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return json({ success: false, ok: false, error: "Invalid JSON body" }, 400);
  }

  const internal = isServiceRoleCall(req);
  console.log("[TRIP_INVOICE] entry", JSON.stringify({ sweep: body.sweep === true, internal }));


  // Legacy cron body. Store a missing PDF only — never email.
  if (body.sweep === true) {
    if (!internal) return json({ success: false, ok: false, error: "Unauthorized" }, 401);
    const supabase = serviceClient();
    const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from("trips")
      .select("id")
      .eq("status", "completed")
      .gte("completed_at", since)
      .is("invoice_generated_at", null)
      .order("completed_at", { ascending: true })
      .limit(SWEEP_LIMIT);

    if (error) return json({ success: false, ok: false, error: error.message }, 500);

    const results: Array<{ trip_id: string; ok: boolean; emailed: false; error?: string }> = [];
    for (const row of data ?? []) {
      const result = await handleTripInvoiceAction(supabase, row.id as string, "generate_only");
      results.push({
        trip_id: row.id as string,
        ok: result.success === true,
        emailed: false,
        error: result.error,
      });
    }
    console.log("[TRIP_INVOICE] sweep_store_only", JSON.stringify({ picked: data?.length ?? 0, results }));
    return json({ success: true, ok: true, emailed: false, processed: results.length, results });
  }

  const tripId = (body.trip_id ?? body.tripId ?? body.bookingId ?? body.booking_id) as string | undefined;
  const action = ((body.action as string) ?? "generate") as TripInvoiceAction;

  if (!tripId) return json({ success: false, ok: false, error: "Missing trip_id" }, 400);
  if (!VALID_ACTIONS.has(action)) return json({ success: false, ok: false, error: `Invalid action: ${action}` }, 400);

  // This function stores the invoice only. Email is send-trip-receipt.
  if (action === "send_email" || action === "resend_email") {
    return json({
      success: false,
      ok: false,
      emailed: false,
      error: "Receipt email requires a manual customer or admin action",
    }, 403);
  }

  let supabase;
  if (internal) {
    supabase = serviceClient();
  } else {
    const gate = await requireAdminOrStaff(req);
    if (!gate.ok) {
      const errBody = await gate.response.json().catch(() => ({ error: "Unauthorized" }));
      return json({ success: false, ok: false, error: errBody.error ?? "Unauthorized" }, 401);
    }
    supabase = serviceClient();
  }

  console.log("[TRIP_INVOICE] request", JSON.stringify({ tripId, action, internal }));

  const result = await handleTripInvoiceAction(supabase, tripId, action);
  return json(result as unknown as Record<string, unknown>);
});
