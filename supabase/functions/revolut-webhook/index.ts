// Revolut Merchant API webhook receiver.
// Signature spec: https://developer.revolut.com/docs/guides/accept-payments/tutorials/work-with-webhooks/verify-the-payload-signature
//
//   Revolut-Request-Timestamp: <unix ms>
//   Revolut-Signature:         v1=<hex-hmac-sha256>[, v2=...]
//
// signed_payload = `v1.${timestamp}.${rawBody}`
// expected      = HMAC_SHA256(REVOLUT_WEBHOOK_SECRET, signed_payload) hex

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  getRevolutMerchantConfig,
  mapRevolutStateToPaymentStatus,
  retrieveRevolutOrder,
} from "../_shared/revolutOrders.ts";
import { revolutMerchantRequest } from "../_shared/revolutApi.ts";

/**
 * Extract provider processing fee (minor units) from a Revolut order payload.
 * Order → payments[].fees[].amount (minor units). Sum all fees across payments.
 * Returns null when the payload has no fee data (never fabricate 0).
 */
function extractRevolutFeeMinor(order: unknown): number | null {
  if (!order || typeof order !== "object") return null;
  const payments = (order as { payments?: unknown }).payments;
  if (!Array.isArray(payments) || payments.length === 0) return null;
  let total = 0;
  let sawFee = false;
  for (const p of payments) {
    if (!p || typeof p !== "object") continue;
    const fees = (p as { fees?: unknown }).fees;
    if (Array.isArray(fees)) {
      for (const f of fees) {
        const amt = (f as { amount?: unknown })?.amount;
        if (typeof amt === "number" && Number.isFinite(amt)) {
          total += amt;
          sawFee = true;
        }
      }
      continue;
    }
    const flatFee = (p as { fee?: unknown }).fee;
    if (typeof flatFee === "number" && Number.isFinite(flatFee)) {
      total += flatFee;
      sawFee = true;
    }
  }
  return sawFee ? Math.round(total) : null;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, revolut-signature, revolut-request-timestamp",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MAX_TIMESTAMP_SKEW_MS = 5 * 60 * 1000; // 5 min

function hexFromBytes(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let hex = "";
  for (let i = 0; i < view.length; i++) hex += view[i].toString(16).padStart(2, "0");
  return hex;
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

async function computeHmac(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return hexFromBytes(sig);
}

interface RevolutWebhookEvent {
  event?: string;
  order_id?: string;
  merchant_order_ext_ref?: string;
  data?: Record<string, unknown> & { state?: string };
}

function numericMinor(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return Math.round(parsed);
    }
  }
  return null;
}

async function resolveAuthorisedAmountMinor(
  orderId: string,
  eventData: Record<string, unknown> | undefined,
): Promise<number | null> {
  const direct = numericMinor(
    eventData?.authorised_amount,
    eventData?.authorized_amount,
    eventData?.amount,
  );
  if (direct != null && direct > 0) return direct;

  try {
    const { secretKey, environment } = getRevolutMerchantConfig();
    const order = await retrieveRevolutOrder(environment, secretKey, orderId);
    const fromOrder = numericMinor(order.amount);
    return fromOrder != null && fromOrder > 0 ? fromOrder : null;
  } catch (error) {
    console.error(`[revolut-webhook] authorised amount lookup failed for ${orderId}:`, (error as Error).message);
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const secret = Deno.env.get("REVOLUT_WEBHOOK_SECRET");
  if (!secret) {
    console.error("[revolut-webhook] REVOLUT_WEBHOOK_SECRET not configured");
    return new Response(JSON.stringify({ error: "webhook_secret_missing" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const rawBody = await req.text();
  const sigHeader = req.headers.get("revolut-signature") ?? "";
  const tsHeader = req.headers.get("revolut-request-timestamp") ?? "";

  if (!sigHeader || !tsHeader) {
    return new Response(JSON.stringify({ error: "missing_signature_headers" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const tsMs = Number(tsHeader);
  if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > MAX_TIMESTAMP_SKEW_MS) {
    return new Response(JSON.stringify({ error: "stale_timestamp" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const expected = await computeHmac(secret, `v1.${tsHeader}.${rawBody}`);
  const provided = sigHeader
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("v1="))
    .map((s) => s.slice(3).toLowerCase());

  if (!provided.some((p) => timingSafeEqualHex(p, expected))) {
    console.error("[revolut-webhook] signature mismatch");
    return new Response(JSON.stringify({ error: "invalid_signature" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let event: RevolutWebhookEvent;
  try {
    event = JSON.parse(rawBody) as RevolutWebhookEvent;
  } catch {
    return new Response(JSON.stringify({ error: "invalid_json" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const orderId = event.order_id ?? null;
  const extRef = event.merchant_order_ext_ref ?? null;
  const eventName = event.event ?? null;

  // === Recovery-path detection ===
  // Recovery orders use ext_ref = `recover:<trip_id>:<sessionUuid>` and are
  // linked to a payment_sessions row of purpose=PAYMENT_RECOVERY. Never mutate
  // trips.provider_order_id or the parent session for recovery events.
  let recoverySession:
    | { id: string; trip_id: string | null; status: string }
    | null = null;
  if (orderId) {
    const { data: recSess } = await supabase
      .from("payment_sessions")
      .select("id, trip_id, status, purpose")
      .eq("provider_order_id", orderId)
      .eq("purpose", "PAYMENT_RECOVERY")
      .maybeSingle();
    if (recSess) {
      recoverySession = { id: recSess.id, trip_id: recSess.trip_id, status: recSess.status };
    }
  }

  // Locate the trip. Prefer provider_order_id, fall back to the ext_ref (trip id)
  // written by create-payment-intent. For recovery orders, use the linked session's trip.
  let tripId: string | null = null;
  if (recoverySession?.trip_id) {
    tripId = recoverySession.trip_id;
  } else {
    if (orderId) {
      const { data } = await supabase
        .from("trips")
        .select("id")
        .eq("payment_provider", "revolut")
        .eq("provider_order_id", orderId)
        .maybeSingle();
      tripId = data?.id ?? null;
    }
    if (!tripId && extRef && !extRef.startsWith("recover:")) tripId = extRef;
  }

  const stateFromEvent =
    (event.data?.state as string | undefined) ??
    (eventName ? eventName.replace(/^ORDER_/, "").toUpperCase() : undefined);
  const stateUpper = String(stateFromEvent ?? "").toUpperCase();
  const nextStatus = mapRevolutStateToPaymentStatus(stateFromEvent);

  // === Recovery lifecycle: never touch parent session or trip.provider_order_id ===
  if (recoverySession) {
    const recoveryNextStatus =
      stateUpper === "COMPLETED" ? "RECOVERY_COMPLETED" :
      stateUpper === "FAILED" ? "RECOVERY_DECLINED" :
      stateUpper === "CANCELLED" ? "RECOVERY_CANCELLED" :
      stateUpper === "EXPIRED" ? "RECOVERY_EXPIRED" :
      null;
    if (recoveryNextStatus) {
      const nowIso = new Date().toISOString();
      const sessionUpdate: Record<string, unknown> = {
        status: recoveryNextStatus,
        updated_at: nowIso,
      };
      const capturedAmt = (event.data as { captured_amount?: unknown; amount?: unknown } | undefined);
      if (recoveryNextStatus === "RECOVERY_COMPLETED") {
        const amt =
          typeof capturedAmt?.captured_amount === "number" ? capturedAmt.captured_amount :
          typeof capturedAmt?.amount === "number" ? capturedAmt.amount :
          null;
        if (amt != null) sessionUpdate.captured_amount_pence = Math.round(amt);
      }
      await supabase.from("payment_sessions").update(sessionUpdate).eq("id", recoverySession.id);

      // Payment Authorisation Lifecycle SSOT: only release the parent hold
      // after a recovery capture succeeds. Never on RECOVERY_DECLINED/CANCELLED/EXPIRED.
      if (recoveryNextStatus === "RECOVERY_COMPLETED" && recoverySession.trip_id) {
        const { data: parent } = await supabase
          .from("payment_sessions")
          .select("id, provider_order_id, provider_state, metadata")
          .eq("trip_id", recoverySession.trip_id)
          .eq("purpose", "RIDE_BOOKING")
          .maybeSingle();
        if (parent && (parent.provider_state ?? "").toUpperCase() === "AUTHORISED" && parent.provider_order_id) {
          try {
            const meta = (parent.metadata && typeof parent.metadata === "object") ? parent.metadata : {};
            await supabase.from("payment_sessions").update({
              metadata: {
                ...meta,
                release_trigger: "recovery_captured",
                release_trigger_at: nowIso,
                recovery_session_id: recoverySession.id,
              },
              updated_at: nowIso,
            }).eq("id", parent.id);
            const { secretKey, environment } = getRevolutMerchantConfig();
            const { cancelRevolutOrder } = await import("../_shared/revolutOrders.ts");
            await cancelRevolutOrder(environment, secretKey, parent.provider_order_id);
            await supabase.from("payment_sessions").update({
              provider_state: "CANCELLED",
              status: "released_after_recovery",
              provider_state_verified_at: nowIso,
              provider_state_verified_by: "recovery_captured",
              updated_at: nowIso,
            }).eq("id", parent.id);
            await supabase.from("trips").update({
              payment_status: "captured",
              updated_at: nowIso,
            }).eq("id", recoverySession.trip_id);
          } catch (releaseErr) {
            console.error(`[revolut-webhook] parent hold release after recovery failed:`, (releaseErr as Error).message);
          }
        }
      }
    }
  } else {
    let finaliseTripId: string | null = null;

    if (orderId) {
      const { data: session } = await supabase
        .from("payment_sessions")
        .select("id, trip_id, status, authorised_amount_pence, metadata")
        .eq("provider_order_id", orderId)
        .eq("purpose", "RIDE_BOOKING")
        .maybeSingle();

      if (session) {
        if (!tripId && session.trip_id) tripId = session.trip_id;

        const nowIso = new Date().toISOString();
        const sessionUpdate: Record<string, unknown> = {
          provider_state: stateUpper || null,
          provider_state_verified_at: nowIso,
          provider_state_verified_by: "webhook",
          updated_at: nowIso,
          metadata: {
            ...((session.metadata && typeof session.metadata === "object") ? session.metadata : {}),
            revolut_last_webhook_event: eventName,
            revolut_last_webhook_state: stateUpper || null,
            revolut_last_webhook_at: nowIso,
          },
        };

        if (["AUTHORISED", "COMPLETED"].includes(stateUpper)) {
          const authorisedAmount = await resolveAuthorisedAmountMinor(orderId, event.data);
          if (authorisedAmount != null && authorisedAmount > 0) {
            sessionUpdate.authorised_amount_pence = authorisedAmount;
            sessionUpdate.total_authorised_amount_pence = authorisedAmount;
          }
          sessionUpdate.authorised_at = nowIso;
          sessionUpdate.status = session.trip_id ? "trip_created" : "payment_authorised";
        } else if (["CANCELLED", "FAILED"].includes(stateUpper)) {
          sessionUpdate.status = stateUpper === "CANCELLED" ? "cancelled" : "failed";
          sessionUpdate.failure_reason = `REVOLUT_${stateUpper}`;
        }

        const { error: sessionUpdateError } = await supabase
          .from("payment_sessions")
          .update(sessionUpdate)
          .eq("id", session.id);
        if (sessionUpdateError) {
          console.error(`[revolut-webhook] payment_session update failed for ${session.id}:`, sessionUpdateError.message);
        }

        if (["AUTHORISED", "COMPLETED"].includes(stateUpper) && !session.trip_id) {
          const { data: finaliseData, error: finaliseError } = await supabase.rpc(
            "finalize_paid_booking_session",
            { p_payment_session_id: session.id },
          );
          if (finaliseError) {
            console.error(`[revolut-webhook] finalize failed for session ${session.id}:`, finaliseError.message);
            await supabase
              .from("payment_sessions")
              .update({
                recovery_attempt_count: 1,
                last_recovery_attempt_at: nowIso,
                metadata: {
                  ...((session.metadata && typeof session.metadata === "object") ? session.metadata : {}),
                  revolut_last_webhook_event: eventName,
                  revolut_last_webhook_state: stateUpper || null,
                  revolut_last_webhook_at: nowIso,
                  last_auto_recovery_error: finaliseError.message,
                  last_auto_recovery_error_at: nowIso,
                },
              })
              .eq("id", session.id);
          } else {
            finaliseTripId = typeof finaliseData === "string" ? finaliseData : null;
            if (finaliseTripId) tripId = finaliseTripId;
            console.log(`[revolut-webhook] finalised authorised session=${session.id} trip=${finaliseTripId ?? "?"}`);
          }
        }
      } else if (stateUpper === "AUTHORISED") {
        console.warn(`[revolut-webhook] authorised order has no RIDE_BOOKING payment_session: ${orderId}`);
      }
    }

    if (tripId && nextStatus) {
    let effectiveStatus = nextStatus;

    // Payment-gate SSOT: if this trip is in additional-auth recovery
    // (child re-hold cancelled/failed) but the ORIGINAL parent order is
    // still AUTHORISED, do NOT flip the trip to `canceled`. Keep it in
    // `recovery_required` so admins can run create-payment-recovery.
    if (nextStatus === "canceled" || nextStatus === "failed") {
      const { data: parentSession } = await supabase
        .from("payment_sessions")
        .select("provider_state, metadata")
        .eq("trip_id", tripId)
        .eq("purpose", "RIDE_BOOKING")
        .maybeSingle();
      const addl =
        (parentSession?.metadata as { additional_auth_status?: string } | null)
          ?.additional_auth_status ?? null;
      if (
        parentSession?.provider_state === "AUTHORISED"
        && addl === "PAYMENT_RECOVERY_REQUIRED"
      ) {
        effectiveStatus = "recovery_required";
      }
    }

    const update: Record<string, unknown> = {
      payment_status: effectiveStatus,
      updated_at: new Date().toISOString(),
    };
    // On terminal capture, keep provider_charge_id fresh from the webhook payload.
    if (effectiveStatus === "captured" && orderId) {
      update.provider_charge_id = orderId;
    }
    const { error } = await supabase.from("trips").update(update).eq("id", tripId);
    if (error) {
      console.error(`[revolut-webhook] trip update failed for ${tripId}:`, error.message);
    }
    }
  }


  // On capture: hydrate provider processing fee from Revolut order details.
  // Writes payment_sessions.provider_processing_fee_pence + trips.provider_fee_pence.
  let feeMinor: number | null = null;
  if (nextStatus === "captured" && orderId) {
    try {
      const secretKey = Deno.env.get("REVOLUT_MERCHANT_SECRET_KEY")
        ?? Deno.env.get("REVOLUT_SECRET_KEY");
      if (secretKey) {
        const order = await revolutMerchantRequest<unknown>(
          "live",
          secretKey,
          `/orders/${encodeURIComponent(orderId)}`,
          { method: "GET" },
        );
        feeMinor = extractRevolutFeeMinor(order);
        if (feeMinor != null) {
          const nowIso = new Date().toISOString();
          const { error: sessErr } = await supabase
            .from("payment_sessions")
            .update({
              provider_processing_fee_pence: feeMinor,
              provider_fee_source: "revolut_order_capture",
              provider_fee_confirmed_at: nowIso,
              updated_at: nowIso,
            })
            .eq("provider_order_id", orderId);
          if (sessErr) {
            console.error(`[revolut-webhook] session fee update failed:`, sessErr.message);
          }
          if (tripId) {
            const { error: tripFeeErr } = await supabase
              .from("trips")
              .update({ provider_fee_pence: feeMinor, updated_at: nowIso })
              .eq("id", tripId);
            if (tripFeeErr) {
              console.error(`[revolut-webhook] trip fee update failed:`, tripFeeErr.message);
            }
          }
        }
      } else {
        console.warn("[revolut-webhook] no merchant secret env; skipping fee hydration");
      }
    } catch (feeErr) {
      console.error(`[revolut-webhook] fee hydration error:`, (feeErr as Error).message);
    }
  }

  // Idempotent audit log.
  const { error: auditError } = await supabase.from("admin_payment_audit").insert({
    action: "revolut_webhook",
    provider: "revolut",
    provider_payment_id: orderId,
    trip_id: tripId,
    metadata: {
      event: eventName,
      state: stateFromEvent ?? null,
      applied_status: nextStatus,
      provider_fee_pence: feeMinor,
      data: event.data ?? null,
    },
  });
  if (auditError) console.error("[revolut-webhook] audit insert failed:", auditError.message);

  console.log(
    `[revolut-webhook] verified event=${eventName ?? "?"} order=${orderId ?? "?"} trip=${tripId ?? "?"} → status=${nextStatus ?? "none"}`,
  );

  return new Response(JSON.stringify({ received: true, applied_status: nextStatus }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
