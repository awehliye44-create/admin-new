import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  isAuthorisedHoldSessionStatus,
  loadPaymentSession,
  markPaymentSessionAbandoned,
} from "../_shared/paymentSessionSSOT.ts";
import {
  releaseHoldForPaymentSession,
  sessionAgeMs,
  shouldForceAuthorisedSessionRelease,
} from "../_shared/holdReleaseSSOT.ts";
import { serveWithEdgeTiming } from "../_shared/edgeFunctionTiming.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const ABANDON_RELEASE_MIN_AGE_MS = 30_000;

const PRE_AUTH_SKIP_STATUSES = new Set([
  "trip_created",
  "dispatching",
  "completed_pending_capture",
  "captured",
  "released",
  "cancelled",
]);

serveWithEdgeTiming("abandon-payment-session", corsHeaders, async (req) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");

  if (!supabaseAnonKey) {
    return json({ error: "SUPABASE_ANON_KEY not set" }, 500);
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false },
  });

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Unauthorized" }, 401);

  const anonClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const token = authHeader.replace("Bearer ", "");
  const { data: claimsData, error: claimsError } = await anonClient.auth.getClaims(token);
  if (claimsError || !claimsData?.claims) return json({ error: "Unauthorized" }, 401);
  const userId = claimsData.claims.sub as string;

  const body = await req.json().catch(() => ({})) as {
    client_action_id?: string;
    provider_order_id?: string;
    reason?: string;
  };

  const clientActionId = String(body.client_action_id ?? "").trim() || null;
  const providerOrderId = String(body.provider_order_id ?? "").trim() || null;
  const reason = String(body.reason ?? "checkout_abandoned").trim() || "checkout_abandoned";

  if (!clientActionId && !providerOrderId) {
    return json({ error: "client_action_id or provider_order_id required" }, 400);
  }

  const session = await loadPaymentSession(supabase, {
    clientActionId,
    providerOrderId,
  });

  if (!session) {
    console.info("PAYMENT_ABANDONED", { client_action_id: clientActionId, provider_order_id: providerOrderId, found: false });
    return json({ success: true, skipped: true, reason: "session_not_found" });
  }

  if (String(session.user_id ?? "") !== userId) {
    return json({ error: "Payment session does not belong to this user" }, 403);
  }

  const status = String(session.status ?? "");
  const orderId = providerOrderId
    ?? (session.provider_order_id ? String(session.provider_order_id) : null);
  const sessionId = String(session.id ?? "");

  if (session.trip_id) {
    console.warn("TRIP_CREATION_BLOCKED", {
      event: "abandon_skipped_has_trip",
      client_action_id: session.client_action_id,
      trip_id: session.trip_id,
      status,
    });
    return json({ success: true, skipped: true, reason: "session_has_trip", status });
  }

  if (PRE_AUTH_SKIP_STATUSES.has(status) || status === "cancelled") {
    return json({ success: true, skipped: true, reason: "session_already_terminal", status });
  }

  // Post-auth abandon: authorised + no trip → release hold.
  // 30s grace is only for checkout-abandon / Try Again. Platform booking
  // failures (CTAP never started) must release immediately.
  if (isAuthorisedHoldSessionStatus(status)) {
    const ageMs = sessionAgeMs(session);
    const forceRelease = shouldForceAuthorisedSessionRelease(reason);
    if (!forceRelease && ageMs < ABANDON_RELEASE_MIN_AGE_MS) {
      return json({
        success: true,
        skipped: true,
        reason: "authorised_too_recent",
        status,
        age_ms: ageMs,
      });
    }

    if (!orderId) {
      return json({ success: false, error: "missing_provider_order_id" }, 400);
    }

    const release = await releaseHoldForPaymentSession(supabase, {
      providerOrderId: orderId,
      clientActionId: clientActionId ?? String(session.client_action_id ?? ""),
      terminalReason: reason,
      source: "abandon-payment-session",
      idempotencyKey: `abandon_release_${sessionId}`,
      session,
    });

    console.info("CHECKOUT_CANCELLED", {
      client_action_id: clientActionId ?? session.client_action_id,
      provider_order_id: orderId,
      reason,
      release,
    });

    if (!release.ok) {
      return json({
        success: false,
        error: release.error ?? "release_failed",
        released: release.released,
        release_status: release.status,
      }, 500);
    }

    return json({
      success: true,
      abandoned: true,
      released: release.released,
      release_status: release.status,
    });
  }

  // Pre-auth / pending: cancel the Revolut order if it exists (PENDING can
  // still authorise later). Then mark the local session abandoned.
  if (orderId) {
    const release = await releaseHoldForPaymentSession(supabase, {
      providerOrderId: orderId,
      clientActionId: clientActionId ?? String(session.client_action_id ?? ""),
      terminalReason: reason,
      source: "abandon-payment-session",
      idempotencyKey: `abandon_pending_${sessionId}`,
      session,
    });
    console.info("CHECKOUT_CANCELLED", {
      client_action_id: clientActionId ?? session.client_action_id,
      provider_order_id: orderId,
      reason,
      release,
    });
    if (release.ok || release.released) {
      return json({
        success: true,
        abandoned: true,
        released: release.released,
        release_status: release.status,
      });
    }

    return json({
      success: false,
      error: release.error ?? "release_failed",
      released: false,
      release_status: release.status,
    }, 500);
  }

  await markPaymentSessionAbandoned(supabase, {
    clientActionId: clientActionId ?? String(session.client_action_id ?? ""),
    providerOrderId: orderId,
    reason,
  });

  console.info("CHECKOUT_CANCELLED", {
    client_action_id: clientActionId ?? session.client_action_id,
    provider_order_id: orderId,
    reason,
    release_status: "abandoned_only",
  });

  return json({
    success: true,
    abandoned: true,
    release_status: "abandoned_only",
  });
});

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
