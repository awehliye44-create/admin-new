/**
 * P0 Stripe runtime retirement — permanent kill switch for active finance.
 * Mirror of onecab-comfy-ride/_shared/stripeRuntimeDisabled.ts
 */

export const STRIPE_RETIRED = "STRIPE_RETIRED";
export const PAYMENT_PROVIDER_UNAVAILABLE = "PAYMENT_PROVIDER_UNAVAILABLE";
export const PAYOUT_PROVIDER_UNAVAILABLE = "PAYOUT_PROVIDER_UNAVAILABLE";
export const STRIPE_FALLBACK_PREVENTED = "STRIPE_FALLBACK_PREVENTED";
export const STRIPE_RUNTIME_BLOCKED = "STRIPE_RUNTIME_BLOCKED";
export const STRIPE_LEGACY_READ = "STRIPE_LEGACY_READ";
export const STRIPE_RETIRED_WEBHOOK_RECEIVED = "STRIPE_RETIRED_WEBHOOK_RECEIVED";
export const LEGACY_STRIPE_EVIDENCE = "LEGACY_STRIPE_EVIDENCE";

export type ActivePaymentProvider =
  | "revolut"
  | "bank_transfer"
  | "unknown"
  | "unavailable";

export type ActivePayoutProvider =
  | "revolut"
  | "bank_transfer"
  | "unknown"
  | "unavailable";

export function isStripeRuntimeDisabled(envGet?: (key: string) => string | undefined): boolean {
  const read = envGet ?? ((k: string) => {
    try {
      return Deno.env.get(k) ?? undefined;
    } catch {
      return undefined;
    }
  });
  return String(read("STRIPE_RUNTIME_DISABLED") ?? "true").trim().toLowerCase() !== "false";
}

export function isStripeProviderName(provider: string | null | undefined): boolean {
  return String(provider ?? "").trim().toLowerCase() === "stripe";
}

export function resolveActivePaymentProviderName(
  raw: string | null | undefined,
): ActivePaymentProvider {
  const p = String(raw ?? "").trim().toLowerCase();
  if (!p) return "unavailable";
  if (p === "stripe") return "unavailable";
  if (p === "revolut") return "revolut";
  if (p === "bank_transfer" || p === "manual" || p === "manual_bank") return "bank_transfer";
  if (p === "unknown") return "unknown";
  if (p === "unavailable" || p === "none") return "unavailable";
  return "unknown";
}

export function resolveActivePayoutProviderName(
  raw: string | null | undefined,
): ActivePayoutProvider {
  const p = String(raw ?? "").trim().toLowerCase();
  if (!p) return "unavailable";
  if (p === "stripe") return "unavailable";
  if (p === "revolut") return "revolut";
  if (p === "bank_transfer" || p === "manual" || p === "manual_bank") return "bank_transfer";
  return "unavailable";
}

export function classifyLegacyStripeEvidence(
  paymentProvider: string | null | undefined,
  providerPaymentId?: string | null,
): typeof LEGACY_STRIPE_EVIDENCE | null {
  if (isStripeProviderName(paymentProvider)) return LEGACY_STRIPE_EVIDENCE;
  const id = String(providerPaymentId ?? "");
  if (id.startsWith("pi_") || id.startsWith("ch_") || id.startsWith("py_") || id.startsWith("po_")) {
    return LEGACY_STRIPE_EVIDENCE;
  }
  return null;
}

export type StripeRetirementTelemetry = {
  event:
    | typeof STRIPE_RUNTIME_BLOCKED
    | typeof STRIPE_FALLBACK_PREVENTED
    | typeof STRIPE_LEGACY_READ
    | typeof STRIPE_RETIRED_WEBHOOK_RECEIVED
    | typeof PAYMENT_PROVIDER_UNAVAILABLE
    | typeof PAYOUT_PROVIDER_UNAVAILABLE;
  function: string;
  operation: string;
  service_area_id?: string | null;
  trip_id?: string | null;
  payment_session_id?: string | null;
  payout_item_id?: string | null;
  correlation_id?: string | null;
};

export function emitStripeRetirementTelemetry(payload: StripeRetirementTelemetry): void {
  console.info(JSON.stringify({
    ...payload,
    timestamp: new Date().toISOString(),
  }));
}

export function stripeRetiredJsonBody(operation: string, extra?: Record<string, unknown>) {
  return {
    success: false,
    error: "Stripe is permanently retired from active ONECAB finance.",
    error_code: STRIPE_RETIRED,
    operation,
    ...extra,
  };
}

export function stripeRetiredHttpResponse(
  corsHeaders: Record<string, string>,
  operation: string,
  status = 422,
  extra?: Record<string, unknown>,
): Response {
  emitStripeRetirementTelemetry({
    event: STRIPE_RUNTIME_BLOCKED,
    function: operation,
    operation,
  });
  return new Response(JSON.stringify(stripeRetiredJsonBody(operation, extra)), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export function assertStripeMutationAllowed(
  corsHeaders: Record<string, string>,
  operation: string,
): Response | null {
  if (!isStripeRuntimeDisabled()) return null;
  return stripeRetiredHttpResponse(corsHeaders, operation);
}

export function assertStripeMutationAllowedOrThrow(operation: string): void {
  if (!isStripeRuntimeDisabled()) return;
  emitStripeRetirementTelemetry({
    event: STRIPE_RUNTIME_BLOCKED,
    function: operation,
    operation,
  });
  throw new Error(STRIPE_RETIRED);
}
