// Revolut Merchant API webhook receiver.
// Signature spec: https://developer.revolut.com/docs/guides/accept-payments/tutorials/work-with-webhooks/verify-the-payload-signature
//
//   Revolut-Request-Timestamp: <unix ms>
//   Revolut-Signature:         v1=<hex-hmac-sha256>[, v2=...]
//
// signed_payload = `v1.${timestamp}.${rawBody}`
// expected      = HMAC_SHA256(REVOLUT_WEBHOOK_SECRET, signed_payload) hex

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { mapRevolutStateToPaymentStatus } from "../_shared/revolutOrders.ts";
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

  // Locate the trip. Prefer provider_order_id, fall back to the ext_ref (trip id)
  // written by create-payment-intent.
  let tripId: string | null = null;
  if (orderId) {
    const { data } = await supabase
      .from("trips")
      .select("id")
      .eq("payment_provider", "revolut")
      .eq("provider_order_id", orderId)
      .maybeSingle();
    tripId = data?.id ?? null;
  }
  if (!tripId && extRef) tripId = extRef;

  const stateFromEvent =
    (event.data?.state as string | undefined) ??
    (eventName ? eventName.replace(/^ORDER_/, "").toUpperCase() : undefined);
  const nextStatus = mapRevolutStateToPaymentStatus(stateFromEvent);

  if (tripId && nextStatus) {
    const update: Record<string, unknown> = {
      payment_status: nextStatus,
      updated_at: new Date().toISOString(),
    };
    // On terminal capture, keep provider_charge_id fresh from the webhook payload.
    if (nextStatus === "captured" && orderId) {
      update.provider_charge_id = orderId;
    }
    const { error } = await supabase.from("trips").update(update).eq("id", tripId);
    if (error) {
      console.error(`[revolut-webhook] trip update failed for ${tripId}:`, error.message);
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
