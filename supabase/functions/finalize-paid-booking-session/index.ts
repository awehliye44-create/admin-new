// finalize-paid-booking-session
//
// The ONLY canonical HTTP entrypoint for creating a digital-payment trip.
// Thin wrapper around the SECURITY DEFINER RPC public.finalize_paid_booking_session.
//
// - Requires an authenticated caller (JWT).
// - The RPC itself performs all authoritative checks: provider AUTHORISED/COMPLETED,
//   positive authorised amount, matching currency/customer/service-area, idempotency.
// - Never broadcasts; the trip's status transition handles dispatch downstream.
// - Returns { ok, trip_id, reason? }.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  corsHeaders, checkRateLimit, getClientIP, rateLimitResponse,
  successResponse, errorResponse,
} from "../_shared/security.ts";

const RATE_LIMIT_CONFIG = { limit: 30, windowMs: 60 * 1000 };

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const clientIP = getClientIP(req);
  const rl = checkRateLimit(clientIP, RATE_LIMIT_CONFIG);
  if (!rl.allowed) return rateLimitResponse(rl.retryAfter!);

  try {
    const auth = req.headers.get("Authorization");
    if (!auth) return errorResponse("Missing authorization header", 401, undefined, "AUTH_MISSING");

    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: { user }, error: authErr } = await sb.auth.getUser(auth.replace("Bearer ", ""));
    if (authErr || !user) return errorResponse("Unauthorized", 401, undefined, "AUTH_INVALID");

    const body = await req.json().catch(() => null);
    const payment_session_id: string | undefined = body?.payment_session_id;
    if (!payment_session_id) {
      return errorResponse("payment_session_id required", 400, undefined, "VALIDATION_MISSING_FIELD");
    }

    // Verify the session belongs to the caller before invoking the RPC (defence in depth).
    const { data: ownership } = await sb
      .from("payment_sessions")
      .select("user_id")
      .eq("id", payment_session_id)
      .maybeSingle();
    if (!ownership) return errorResponse("payment_session not found", 404, undefined, "SESSION_NOT_FOUND");
    if (ownership.user_id !== user.id) return errorResponse("Forbidden", 403, undefined, "AUTH_INVALID");

    const { data, error } = await sb.rpc("finalize_paid_booking_session", {
      p_payment_session_id: payment_session_id,
    });

    if (error) {
      const msg = String(error.message || "");
      const status = msg.includes("PAYMENT_GATE_NOT_SATISFIED") ? 409 : 500;
      return errorResponse(msg, status, undefined, "FINALIZE_FAILED");
    }

    return successResponse(data ?? {});
  } catch (e) {
    console.error("[finalize-paid-booking-session] error", e);
    return errorResponse(e instanceof Error ? e.message : "Unknown error", 500);
  }
});
