import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, jsonResponse, requireAdmin } from "../_shared/adminPaymentGate.ts";

// Retired: this path refunded at Revolut without a Payment Session refund record, driver
// wallet reversal or already-refunded check. admin-refund-trip-payment is the only refund path.
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const gate = await requireAdmin(req);
  if (!gate.ok) return gate.response;
  return jsonResponse({
    error: "This refund route is retired. Use the trip refund action in Admin.",
    code: "REFUND_ROUTE_RETIRED",
    replacement: "admin-refund-trip-payment",
  }, 410);
});
