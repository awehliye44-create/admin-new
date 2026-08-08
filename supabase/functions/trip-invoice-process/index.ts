import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, requireAdminOrStaff } from "../_shared/adminPaymentGate.ts";
import { handleTripInvoiceAction, type TripInvoiceAction } from "../_shared/tripInvoice.ts";

const VALID_ACTIONS = new Set<TripInvoiceAction>([
  "generate",
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

  // Automatic sweep: invoked by pg_cron for completed trips missing an invoice email.
  if (body.sweep === true) {
    if (!internal) return json({ success: false, ok: false, error: "Unauthorized" }, 401);
    const supabase = serviceClient();
    const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from("trips")
      .select("id")
      .eq("status", "completed")
      .gte("completed_at", since)
      .or("invoice_email_sent.is.null,invoice_email_sent.eq.false")
      .not("invoice_email_status", "in", '("sent","skipped_no_email")')
      .order("completed_at", { ascending: true })
      .limit(SWEEP_LIMIT);

    if (error) return json({ success: false, ok: false, error: error.message }, 500);

    const results: Array<{ trip_id: string; ok: boolean; error?: string }> = [];
    for (const row of data ?? []) {
      const result = await handleTripInvoiceAction(supabase, row.id as string, "generate");
      results.push({ trip_id: row.id as string, ok: Boolean(result.emailed), error: result.error });
    }
    console.log("[TRIP_INVOICE] sweep", JSON.stringify({ picked: data?.length ?? 0, results }));
    return json({ success: true, ok: true, processed: results.length, results });
  }

  const tripId = (body.trip_id ?? body.tripId ?? body.bookingId ?? body.booking_id) as string | undefined;
  const action = ((body.action as string) ?? "generate") as TripInvoiceAction;

  if (!tripId) return json({ success: false, ok: false, error: "Missing trip_id" }, 400);
  if (!VALID_ACTIONS.has(action)) return json({ success: false, ok: false, error: `Invalid action: ${action}` }, 400);

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
