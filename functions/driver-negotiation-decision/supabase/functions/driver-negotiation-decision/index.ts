/**
 * driver-negotiation-decision — DEPRECATED (410 for all actions).
 *
 * SINGLE OWNER per negotiation action:
 * - Driver accepts customer counter → edge `driver-fare-final` action ACCEPT
 * - Driver declines counter         → edge `driver-fare-final` action DECLINE
 * - Cancel / manual final reject    → automatic on countdown expiry (expire-offers)
 *
 * This edge previously duplicated the counter-accept path (ACCEPT_COUNTER /
 * ACCEPT_FARE / ACCEPT_CUSTOMER_COUNTER → accept_ride_offer), creating a second
 * accept owner. It is kept deployed only so legacy clients receive an explicit
 * 410 with the canonical path instead of a 404.
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  let action: string | null = null;
  let offerId: string | null = null;
  try {
    const body = await req.json() as Record<string, unknown>;
    action = typeof body.action === "string" ? body.action : null;
    offerId = (body.offerId ?? body.offer_id ?? body.negotiationId ?? body.negotiation_id ?? null) as
      | string
      | null;
  } catch {
    // fall through — still respond 410
  }

  console.warn("[driver-negotiation-decision] DEPRECATED_EDGE_CALLED", {
    action,
    offer_id: offerId,
  });

  return jsonResponse({
    success: false,
    error: "DEPRECATED_ENDPOINT",
    message:
      "driver-negotiation-decision is retired. Use driver-fare-final (ACCEPT / DECLINE); manual cancel is automatic on countdown expiry.",
    canonical_endpoint: "driver-fare-final",
  }, 410);
});
