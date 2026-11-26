/**
 * #110 P6 H1 — Corporate cancel is a thin, gated forwarder to cancel-trip.
 *
 * Canonical money / hold / offer / waiting disposition lives only in cancel-trip
 * → disposeTerminalTripPayment. This function never writes trips.status or fees.
 *
 * Auth (defence in depth, server-derived):
 * - Corporate member of the trip's corporate_account_id, OR
 * - Staff with active-trips / corporate-accounts page access.
 * Never trust body cancelled_by_role.
 */
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { requireAnyPageAccess } from "../_shared/adminPaymentGate.ts";

const STAFF_CANCEL_PAGES = ["active-trips", "corporate-accounts"];

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const supabaseAuth = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await supabaseAuth.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const trip_id = typeof body.trip_id === "string" ? body.trip_id : "";
    const reason = typeof body.reason === "string" ? body.reason : "";
    const note = typeof body.note === "string" ? body.note : null;

    if (!trip_id || !reason) {
      return new Response(JSON.stringify({ error: "trip_id and reason are required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: trip, error: tripError } = await supabase
      .from("trips")
      .select("id, corporate_account_id, status")
      .eq("id", trip_id)
      .maybeSingle();

    if (tripError || !trip) {
      return new Response(JSON.stringify({ error: "Trip not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let callerRole: "corporate" | "admin" = "corporate";
    let callerAllowed = false;
    if (trip.corporate_account_id) {
      const [{ data: cu }, { data: cua }] = await Promise.all([
        supabase.from("corporate_users").select("id")
          .eq("user_id", user.id).eq("corporate_account_id", trip.corporate_account_id).limit(1),
        supabase.from("corporate_user_accounts").select("id")
          .eq("user_id", user.id).eq("corporate_account_id", trip.corporate_account_id).limit(1),
      ]);
      callerAllowed = (cu?.length ?? 0) > 0 || (cua?.length ?? 0) > 0;
    }
    if (!callerAllowed) {
      const staffGate = await requireAnyPageAccess(
        { ok: true, supabase, userId: user.id },
        STAFF_CANCEL_PAGES,
      );
      if (staffGate.ok) {
        callerAllowed = true;
        callerRole = "admin";
      }
    }
    if (!callerAllowed) {
      // Same 404 as membership miss — do not leak trip existence.
      return new Response(JSON.stringify({ error: "Trip not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Forward caller JWT — cancel-trip requireUser + corporate/staff authority.
    // Corporate members use rider fee semantics; staff use admin.
    const cancelled_by = callerRole === "admin" ? "admin" : "rider";
    const reasonText = note && reason === "Other" ? `${reason}: ${note}` : reason;

    const res = await fetch(`${supabaseUrl}/functions/v1/cancel-trip`, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        apikey: anonKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        trip_id,
        cancelled_by,
        reason: reasonText,
      }),
    });

    const json = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (!res.ok) {
      return new Response(JSON.stringify({
        error: typeof json.error === "string" ? json.error : "Cancel failed",
        detail: json,
      }), {
        status: res.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const feePence = Math.max(
      0,
      Math.round(Number(json.fee_pence ?? json.cancellation_fee_pence ?? 0) || 0),
    );

    return new Response(
      JSON.stringify({
        success: true,
        cancellation_fee_pence: feePence,
        cancelled_by_role: callerRole,
        financial_outcome: json.financial_outcome ?? null,
        message: feePence > 0
          ? `Trip cancelled with a ${(feePence / 100).toFixed(2)} fee.`
          : "Trip cancelled successfully.",
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("cancel-corporate-trip error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
