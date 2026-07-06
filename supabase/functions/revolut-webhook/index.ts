// Revolut Merchant API webhook receiver.
// Signature spec: https://developer.revolut.com/docs/guides/accept-payments/tutorials/work-with-webhooks/verify-the-payload-signature
//
// Headers sent by Revolut:
//   Revolut-Request-Timestamp: <unix ms>
//   Revolut-Signature:         v1=<hex-hmac-sha256>[, v2=...]
//
// signed_payload = `v1.${timestamp}.${rawBody}`
// expected      = HMAC_SHA256(REVOLUT_WEBHOOK_SECRET, signed_payload) hex

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

  let event: {
    event?: string;
    order_id?: string;
    merchant_order_ext_ref?: string;
    data?: Record<string, unknown>;
  };
  try {
    event = JSON.parse(rawBody);
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

  // Idempotent audit log (relies on existing admin_payment_audit table).
  await supabase.from("admin_payment_audit").insert({
    action: "revolut_webhook",
    provider: "revolut",
    provider_payment_id: event.order_id ?? null,
    trip_id: event.merchant_order_ext_ref ?? null,
    metadata: { event: event.event, data: event.data ?? null },
  }).then(({ error }) => {
    if (error) console.error("[revolut-webhook] audit insert failed:", error.message);
  });

  // Business logic (capture/refund state sync) is wired in Phase 2 when
  // customer-facing checkout goes live. For now we just ACK a verified event.
  console.log(`[revolut-webhook] verified event=${event.event ?? "?"} order=${event.order_id ?? "?"}`);

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
