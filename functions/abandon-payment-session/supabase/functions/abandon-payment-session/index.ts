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
import { reconcileReceivablesOnAbandonOrCancel } from "../_shared/customerReceivableLifecycle.ts";

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
  const providerState = session.provider_state
    ? String(session.provider_state)
    : null;
  const capturedPence = Math.max(
    0,
    Math.round(Number(session.captured_amount_pence) || 0),
  );

  async function reconcileReceivables(args: {
    hold_safely_released?: boolean;
    settle?: boolean;
    /** Override stale session.provider_state after GET→cancel (PENDING→CANCELLED). */
    provider_state_override?: string | null;
  }): Promise<Record<string, unknown> | null> {
    if (!sessionId) return null;
    try {
      const result = await reconcileReceivablesOnAbandonOrCancel(supabase, {
        payment_session_id: sessionId,
        provider_order_id: orderId,
        provider_state: args.provider_state_override ?? providerState,
        has_capture: capturedPence > 0,
        hold_safely_released: args.hold_safely_released === true,
        reason: `abandon:${reason}`,
        settle_evidence: args.settle && orderId && capturedPence > 0
          ? {
            orderId,
            terminalState: "COMPLETED",
            confirmedCapturedPence: capturedPence,
            amountFromProviderGet: true as const,
          }
          : null,
        current_trip_fare_pence: 0,
      });
      if (!result.ok) {
        console.error("[abandon-payment-session] receivable reconcile failed", result.error);
        return {
          receivable_action: "MANUAL_REVIEW",
          receivable_error: result.error.code,
        };
      }
      return {
        receivable_action: result.data.action,
        receivable_released: result.data.released,
        receivable_settled: result.data.settled,
        receivable_reason: result.data.reason,
      };
    } catch (err) {
      console.error("[abandon-payment-session] receivable reconcile exception", err);
      return { receivable_action: "ERROR", receivable_error: String(err) };
    }
  }

  if (session.trip_id) {
    console.warn("TRIP_CREATION_BLOCKED", {
      event: "abandon_skipped_has_trip",
      client_action_id: session.client_action_id,
      trip_id: session.trip_id,
      status,
    });
    return json({ success: true, skipped: true, reason: "session_has_trip", status });
  }

  // Terminal captured sessions: settle covered receivables if evidence exists; never duplicate.
  if (status === "captured" || capturedPence > 0) {
    const recv = await reconcileReceivables({ settle: true });
    return json({
      success: true,
      skipped: true,
      reason: "session_already_terminal_captured",
      status,
      ...recv,
    });
  }

  if (PRE_AUTH_SKIP_STATUSES.has(status) || status === "cancelled") {
    // Idempotent abandon/cancel race: still run planner (RELEASE if no order / failed).
    const recv = await reconcileReceivables({
      hold_safely_released: status === "released" || status === "cancelled",
    });
    return json({
      success: true,
      skipped: true,
      reason: "session_already_terminal",
      status,
      ...recv,
    });
  }

  // Post-auth abandon: authorised + no trip → release hold, then receivables.
  if (isAuthorisedHoldSessionStatus(status)) {
    const ageMs = sessionAgeMs(session);
    const forceRelease = shouldForceAuthorisedSessionRelease(reason);
    if (!forceRelease && ageMs < ABANDON_RELEASE_MIN_AGE_MS) {
      // Keep RESERVED — hold not safely released yet.
      const recv = await reconcileReceivables({ hold_safely_released: false });
      return json({
        success: true,
        skipped: true,
        reason: "authorised_too_recent",
        status,
        age_ms: ageMs,
        ...recv,
      });
    }

    if (!orderId) {
      const recv = await reconcileReceivables({ hold_safely_released: false });
      return json({ success: false, error: "missing_provider_order_id", ...recv }, 400);
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
      // UNKNOWN / timeout / failed release → KEEP RESERVED (same-order reconcile).
      const recv = await reconcileReceivables({ hold_safely_released: false });
      return json({
        success: false,
        error: release.error ?? "release_failed",
        released: release.released,
        release_status: release.status,
        ...recv,
      }, 500);
    }

    const holdSafe = release.released === true || release.ok === true;
    const recv = await reconcileReceivables({
      hold_safely_released: holdSafe,
      provider_state_override: holdSafe ? "CANCELLED" : providerState,
    });

    return json({
      success: true,
      abandoned: true,
      released: release.released,
      release_status: release.status,
      ...recv,
    });
  }

  // Pre-auth / pending: GET same order first (inside releaseHold), cancel when safe.
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
      // Same-order GET→cancel (or already CANCELLED) proven — pass CANCELLED so
      // planReleaseOnCancel does not KEEP on stale session provider_state=null/PENDING
      // (OR_BIBED_13 / payment-UI ghost reservation root cause).
      const recv = await reconcileReceivables({
        hold_safely_released: true,
        provider_state_override: "CANCELLED",
      });
      return json({
        success: true,
        abandoned: true,
        released: release.released,
        release_status: release.status,
        ...recv,
      });
    }

    // UNKNOWN / cancel failed — retain RESERVED; same-order reconcile only.
    const recv = await reconcileReceivables({ hold_safely_released: false });
    return json({
      success: false,
      error: release.error ?? "release_failed",
      released: false,
      release_status: release.status,
      ...recv,
    }, 500);
  }

  // No provider order — safe to release allocations to OPEN.
  await markPaymentSessionAbandoned(supabase, {
    clientActionId: clientActionId ?? String(session.client_action_id ?? ""),
    providerOrderId: orderId,
    reason,
  });

  const recv = await reconcileReceivables({ hold_safely_released: false });

  console.info("CHECKOUT_CANCELLED", {
    client_action_id: clientActionId ?? session.client_action_id,
    provider_order_id: orderId,
    reason,
    release_status: "abandoned_only",
    ...recv,
  });

  return json({
    success: true,
    abandoned: true,
    release_status: "abandoned_only",
    ...recv,
  });
});

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
