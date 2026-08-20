import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, jsonResponse, requireAdmin } from "../_shared/adminPaymentGate.ts";

/** Exported for behavioural tests — production entry uses serve(). */
export async function handleRevolutCaptureOrderRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const gate = await requireAdmin(req);
  if (!gate.ok) return gate.response;

  return jsonResponse({
    success: false,
    error: "This endpoint is disabled. Use admin-capture-trip-payment.",
    error_code: "LEGACY_CAPTURE_ENDPOINT_DISABLED",
    retry_provider_capture: false,
  }, 410);
}

/**
 * Legacy admin capture endpoint — retired (Step 8.2A).
 * Use admin-capture-trip-payment with canonical Payment Session ownership instead.
 */
if (import.meta.main) {
  serve(handleRevolutCaptureOrderRequest);
}
