import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { requireAuthenticatedUser } from "../_shared/edgeAuth.ts";
import { disposeTerminalTripPayment } from "../_shared/terminalTripPaymentDisposition.ts";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version, x-supabase-client-timezone",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const ALLOWED_ROLES = new Set([
  "super_admin",
  "admin",
  "operator",
  "finance_manager",
  "customer_support",
  "compliance_officer",
]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // 1) Authenticate user session
    const auth = await requireAuthenticatedUser(req, supabaseUrl, supabaseAnonKey);
    if (!auth.ok) {
      return auth.response;
    }
    const userId = auth.userId;

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // 2) Verify role-based access
    const { data: staff, error: staffErr } = await supabase
      .from("staff_profiles")
      .select("role, is_active")
      .eq("id", userId)
      .maybeSingle();

    if (staffErr || !staff) {
      console.warn(`[admin-trip-actions] Access denied: user=${userId} is not a staff member`);
      return json({ error: "Access denied. Admin role required." }, 403);
    }

    if (staff.is_active === false) {
      console.warn(`[admin-trip-actions] Access denied: user=${userId} staff profile is suspended`);
      return json({ error: "Access denied. Account is inactive." }, 403);
    }

    if (!ALLOWED_ROLES.has(staff.role)) {
      console.warn(`[admin-trip-actions] Access denied: user=${userId} role=${staff.role} unauthorized`);
      return json({ error: "Access denied. Insufficient permissions." }, 403);
    }

    const { action, trip_id, reason } = await req.json();

    if (action !== "cancel") {
      return json({ error: `Unsupported action: ${action}` }, 400);
    }

    if (!trip_id) {
      return json({ error: "trip_id is required" }, 400);
    }

    console.log(`[admin-trip-actions] Executing cancel: trip=${trip_id} admin=${userId}`);

    // 3) Terminal trip state via existing RPC (same as prior Admin cancel).
    const { data: cancelResult, error: cancelErr } = await supabase.rpc(
      "apply_terminal_trip_cancellation",
      {
        p_trip_id: trip_id,
        p_cancelled_by: "admin",
        p_reason: reason || "Cancelled by admin",
      },
    );

    if (cancelErr) {
      console.error("[admin-trip-actions] Cancellation failed:", cancelErr);
      return json({ error: "Cancellation failed", details: cancelErr.message }, 500);
    }

    if (
      cancelResult &&
      typeof cancelResult === "object" &&
      (cancelResult as { success?: boolean }).success === false
    ) {
      return json({
        error: (cancelResult as { error?: string }).error || "Cancellation failed",
        result: cancelResult,
      }, 400);
    }

    // 4) SAME dispose path as cancel-trip — void/release current Revolut order.
    // Admin cancel is no-fee full release (forceFeePenceOverride: 0). Idempotent
    // via terminal_disposition_key on the payment session.
    let holdDisposition: Awaited<ReturnType<typeof disposeTerminalTripPayment>> | null = null;
    try {
      holdDisposition = await disposeTerminalTripPayment(supabase, {
        tripId: trip_id,
        reason: "admin_cancel",
        feePence: 0,
        forceFeePenceOverride: true,
      });
      console.log("[PAYMENT_AUDIT] admin-trip-actions hold disposition", {
        trip_id,
        ...holdDisposition,
      });
    } catch (holdErr) {
      console.error(
        "[PAYMENT_AUDIT] admin-trip-actions hold disposition failed (non-fatal to trip cancel):",
        holdErr,
      );
    }

    return json({
      success: true,
      result: cancelResult,
      hold_disposition: holdDisposition,
    });
  } catch (err) {
    console.error("[admin-trip-actions] Unexpected error:", err);
    return json({ error: "Internal server error" }, 500);
  }
});
