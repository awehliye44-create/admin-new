/**
 * Provider-neutral digital card settlement helpers for stop-workflow.
 * Revolut is the only active card provider — do not gate on legacy payment-intent columns.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { recordCardCaptureFailure } from "./onecabFinanceLedger.ts";
import {
  resolveTripPaymentProvider,
  tripProviderOrderId,
  type TripProviderRow,
} from "./tripPaymentProviderSSOT.ts";

const CARD_METHODS = new Set([
  "card",
  "apple_pay",
  "google_pay",
  "applepay",
  "googlepay",
]);

export function isCardPaymentMethod(paymentMethod: string | null | undefined): boolean {
  const method = String(paymentMethod ?? "").trim().toLowerCase();
  if (!method || method === "cash") return false;
  return CARD_METHODS.has(method) || method.includes("card") || method.includes("pay");
}

/**
 * Card trip that must settle via existing Revolut finalize/capture.
 * EXISTING CODE REPAIRED — replaces legacy payment-intent existence checks.
 */
export function requiresProviderSettlement(trip: TripProviderRow & {
  payment_method?: string | null;
  payment_session_id?: string | null;
  financial_model?: string | null;
}): boolean {
  if (
    String(trip.financial_model ?? "").toUpperCase()
    === "DRIVER_COLLECTED_COMMISSION_WALLET"
  ) {
    return false;
  }
  if (!isCardPaymentMethod(trip.payment_method)) return false;
  const provider = resolveTripPaymentProvider(trip);
  if (provider !== "revolut") return false;
  return Boolean(tripProviderOrderId(trip) || trip.payment_session_id);
}

/** @deprecated use requiresProviderSettlement */
export function isDigitalCardTrip(trip: {
  payment_method?: string | null;
  provider_order_id?: string | null;
  payment_provider?: string | null;
  payment_session_id?: string | null;
}): boolean {
  return requiresProviderSettlement(trip);
}

export async function recordTripCaptureFailure(
  supabase: SupabaseClient,
  tripId: string,
  message: string,
  _providerOrderId?: string | null,
): Promise<void> {
  await recordCardCaptureFailure(supabase, {
    tripId,
    message,
  });
}

export { recordCardCaptureFailure };
