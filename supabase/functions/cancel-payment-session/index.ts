// cancel-payment-session
//
// P0 payment gate — customer checkout cancellation path.
// Called by the customer app when the user closes/dismisses the Revolut checkout
// sheet (X, back button, Apple Pay cancel, Google Pay cancel) before the
// provider emits ORDER_AUTHORISED.
//
// This function ONLY moves a payment_session that is still in a non-authoritative
// state (pending_payment / authorising / provider_state=PENDING/CHECKOUT_CREATED)
// into `cancelled` with failure_reason='CUSTOMER_CANCELLED'. It NEVER touches an
// AUTHORISED / COMPLETED session — those are provider-owned and must go through
// revolut-cancel-order.
//
// The client must call the canonical finalize_paid_booking_session RPC to create
// a trip. This endpoint creates no trip, broadcasts nothing, and leaves the
// booking draft intact for retry.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  corsHeaders, checkRateLimit, getClientIP, rateLimitResponse,
  successResponse, errorResponse, logAuditEvent,
} from "../_shared/security.ts";

const RATE_LIMIT_CONFIG = { limit: 20, windowMs: 60 * 1000 };

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const clientIP = getClientIP(req);
  const rl = checkRateLimit(clientIP, RATE_LIMIT_CONFIG);
  if (!rl.allowed) return rateLimitResponse(rl.retryAfter!);

  try {
    const auth = req.headers.get("Authorization");
    if (!auth) return errorResponse("Missing authorization header", 401, undefined, "AUTH_MISSING");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: { user }, error: authErr } = await supabase.auth.getUser(auth.replace("Bearer ", ""));
    if (authErr || !user) return errorResponse("Unauthorized", 401, undefined, "AUTH_INVALID");

    const body = await req.json().catch(() => null);
    const payment_session_id: string | undefined = body?.payment_session_id;
    const reason: string = String(body?.reason ?? "CUSTOMER_CANCELLED").toUpperCase();

    if (!payment_session_id) {
      return errorResponse("payment_session_id required", 400, undefined, "VALIDATION_MISSING_FIELD");
    }

    const { data: ps, error: psErr } = await supabase
      .from("payment_sessions")
      .select("id, user_id, status, provider_state, authorised_amount_pence, trip_id")
      .eq("id", payment_session_id)
      .maybeSingle();

    if (psErr || !ps) return errorResponse("payment_session not found", 404, undefined, "SESSION_NOT_FOUND");
    if (ps.user_id !== user.id) return errorResponse("Forbidden", 403, undefined, "AUTH_INVALID");

    const provState = String(ps.provider_state ?? "").toUpperCase();
    const authoritative = provState === "AUTHORISED" || provState === "COMPLETED";

    // Refuse to cancel an authoritative session — those must be released via revolut-cancel-order.
    if (authoritative) {
      return errorResponse(
        "Cannot client-cancel an authoritative session; use provider cancel/void flow",
        409, { provider_state: ps.provider_state, status: ps.status },
        "SESSION_ALREADY_AUTHORISED",
      );
    }

    // Idempotent: already cancelled/orphaned
    if (["cancelled", "failed", "payment_orphaned", "orphan_authorisation"].includes(String(ps.status))) {
      return successResponse({
        payment_session_id: ps.id,
        status: ps.status,
        idempotent: true,
        trip_created: false,
      });
    }

    const { error: updErr } = await supabase
      .from("payment_sessions")
      .update({
        status: "cancelled",
        failure_reason: reason,
        updated_at: new Date().toISOString(),
      })
      .eq("id", ps.id);

    if (updErr) {
      console.error("[cancel-payment-session] update failed", updErr);
      return errorResponse(updErr.message, 500);
    }

    await logAuditEvent(supabase, "PAYMENT_SESSION_CUSTOMER_CANCELLED", {
      details: {
        payment_session_id: ps.id,
        reason,
        provider_state_at_cancel: ps.provider_state,
        prior_status: ps.status,
      },
      ipAddress: clientIP,
      userAgent: req.headers.get("user-agent") || "unknown",
    });

    return successResponse({
      payment_session_id: ps.id,
      status: "cancelled",
      trip_created: false,
      broadcast: false,
      draft_preserved: true,
    });
  } catch (e) {
    console.error("[cancel-payment-session] error", e);
    return errorResponse(e instanceof Error ? e.message : "Unknown error", 500);
  }
});
