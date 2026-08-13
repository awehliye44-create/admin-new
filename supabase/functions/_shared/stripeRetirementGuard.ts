/**
 * Phase 5 — block Stripe customer paths in Revolut service areas.
 * Legacy Stripe trips continue to use trip-level provider fields.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  assertGatewayExecutable,
  checkServiceAreaGateway,
  gatewayNotConfiguredResponse,
} from "./paymentGatewayGuard.ts";

export const STRIPE_RETIRED_IN_REVOLUT_AREA = "STRIPE_RETIRED_IN_REVOLUT_AREA";

export function looksLikeStripePaymentIntentId(value: string | null | undefined): boolean {
  return String(value ?? "").trim().startsWith("pi_");
}

export function stripeRetiredResponse(
  corsHeaders: Record<string, string>,
  provider: string | null,
): Response {
  return new Response(JSON.stringify({
    error: "This area uses a different payment provider. Saved cards from another provider are not available here.",
    error_code: STRIPE_RETIRED_IN_REVOLUT_AREA,
    payment_provider: provider,
  }), {
    status: 422,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export async function assertStripeCustomerPathAllowed(args: {
  supabase: SupabaseClient;
  serviceAreaId: string | null | undefined;
  corsHeaders: Record<string, string>;
  requireServiceArea?: boolean;
}): Promise<Response | null> {
  const serviceAreaId = args.serviceAreaId?.trim() || null;
  if (!serviceAreaId) {
    if (args.requireServiceArea) {
      return new Response(JSON.stringify({
        error: "service_area_id is required",
        error_code: "SERVICE_AREA_REQUIRED",
      }), {
        status: 422,
        headers: { ...args.corsHeaders, "Content-Type": "application/json" },
      });
    }
    return null;
  }

  const gatewayCheck = assertGatewayExecutable(
    await checkServiceAreaGateway(args.supabase, serviceAreaId, "customer"),
  );
  if (!gatewayCheck.ok) {
    return gatewayNotConfiguredResponse(gatewayCheck, args.corsHeaders);
  }
  if (gatewayCheck.provider === "revolut") {
    return stripeRetiredResponse(args.corsHeaders, gatewayCheck.provider);
  }
  return null;
}

export async function resolveTripServiceAreaProvider(
  supabase: SupabaseClient,
  tripId: string,
): Promise<{ serviceAreaId: string | null; provider: string | null }> {
  const { data: trip } = await supabase
    .from("trips")
    .select("service_area_id, payment_provider")
    .eq("id", tripId)
    .maybeSingle();

  const serviceAreaId = (trip?.service_area_id as string | null) ?? null;
  if ((trip?.payment_provider as string | null)?.toLowerCase() === "revolut") {
    return { serviceAreaId, provider: "revolut" };
  }
  if (!serviceAreaId) return { serviceAreaId: null, provider: null };

  const gatewayCheck = await checkServiceAreaGateway(supabase, serviceAreaId, "customer");
  return { serviceAreaId, provider: gatewayCheck.provider };
}
