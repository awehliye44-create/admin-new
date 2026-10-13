import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { requireAuthenticatedUser } from "../_shared/edgeAuth.ts";
import { notifyCustomerTripLifecycle } from "../_shared/customerTripLifecycleNotify.ts";
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

    // 2) Verify role-based access — staff_profiles.user_id is auth.users.id.
    // Looking up by staff_profiles.id rejects every real admin (403 → generic
    // "Edge Function returned a non-2xx status code" toast on Active Trips).
    const { data: staff, error: staffErr } = await supabase
      .from("staff_profiles")
      .select("role, is_active")
      .eq("user_id", userId)
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

    const writeAdminAudit = async (eventType: string, details: Record<string, unknown>) => {
      const { error: auditErr } = await supabase.from("audit_logs").insert({
        event_type: eventType,
        user_id: userId,
        trip_id,
        details: { staff_role: staff.role, reason: reason || null, source: "admin-trip-actions", ...details },
        user_agent: req.headers.get("user-agent"),
      });
      if (auditErr) console.error("[admin-trip-actions] audit write failed:", auditErr.message);
    };

    const { data: current } = await supabase
      .from("trips")
      .select("status, completed_at")
      .eq("id", trip_id)
      .maybeSingle();
    if (!current) return json({ error: "Trip not found" }, 404);
    if (current.status === "completed" || current.completed_at) {
      await writeAdminAudit("ADMIN_TRIP_CANCEL_REFUSED", {
        refusal: "COMPLETED_TRIP_NOT_CANCELLABLE",
        trip_status: current.status,
      });
      return json({
        error: "COMPLETED_TRIP_NOT_CANCELLABLE",
        message: "This trip is completed and cannot be cancelled. Use a refund or adjustment instead.",
      }, 409);
    }

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
      const locked = /TERMINAL_STATE_LOCKED/.test(cancelErr.message ?? "");
      await writeAdminAudit("ADMIN_TRIP_CANCEL_REFUSED", {
        refusal: locked ? "TERMINAL_STATE_LOCKED" : "RPC_ERROR",
      });
      return locked
        ? json({ error: "COMPLETED_TRIP_NOT_CANCELLABLE", message: "This trip is completed and cannot be cancelled." }, 409)
        : json({ error: "Cancellation failed", details: cancelErr.message }, 500);
    }

    if (
      cancelResult &&
      typeof cancelResult === "object" &&
      (cancelResult as { success?: boolean }).success === false
    ) {
      const rpcError = (cancelResult as { error?: string }).error || "Cancellation failed";
      await writeAdminAudit("ADMIN_TRIP_CANCEL_REFUSED", { refusal: rpcError });
      return json({
        error: rpcError,
        result: cancelResult,
      }, rpcError === "COMPLETED_TRIP_NOT_CANCELLABLE" ? 409 : 400);
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

    await writeAdminAudit("ADMIN_TRIP_CANCELLED", {
      previous_status: current.status,
      already_terminal: (cancelResult as { already_terminal?: boolean } | null)?.already_terminal === true,
      hold_disposition_outcome: holdDisposition?.outcome ?? null,
      hold_disposition_key: holdDisposition?.disposition_key ?? null,
    });

    // After terminal cancel succeeds — Customer trip_cancelled lifecycle push.
    try {
      const { data: tripRow } = await supabase
        .from("trips")
        .select("passenger_id")
        .eq("id", trip_id)
        .maybeSingle();
      const passengerId =
        typeof tripRow?.passenger_id === "string" ? tripRow.passenger_id : null;
      if (passengerId) {
        await notifyCustomerTripLifecycle(supabase, {
          passengerId,
          tripId: trip_id,
          event: "trip_cancelled",
          body: "Your trip has been cancelled by ONECAB.",
        });
      }
    } catch (notifyErr) {
      console.warn(
        "[admin-trip-actions] customer trip_cancelled push failed (non-fatal):",
        notifyErr,
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
