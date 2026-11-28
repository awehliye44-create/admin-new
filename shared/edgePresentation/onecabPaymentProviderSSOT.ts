/** Admin presentation-only helpers; not part of Edge uploads. */
import { OnecabCustomerPaymentMethod, ONECAB_PAYMENT_PRODUCTION_RULES, FORBIDDEN_CUSTOMER_PROVIDER_COPY, CUSTOMER_PAYMENT_METHOD_LABELS, ManualPayoutReason, DRIVER_PAYOUT_MANUAL_EXCEPTION_REASONS, PaymentRoutingStep, SavedCardBookingFlow } from "../../supabase/functions/_shared/onecabPaymentProviderSSOT.ts";


/**
 * Methods auto-enabled when the configured service-area adapter supports them.
 * Admin toggles may further restrict; adapter capability is the ceiling.
 */
export const AUTO_ENABLE_WHEN_ADAPTER_SUPPORTS: readonly OnecabCustomerPaymentMethod[] = [
  "apple_pay",
  "google_pay",
  "mobile_wallet",
  "pay_by_bank",
] as const;


/**
 * Reference routing — service area → collection/payout adapter (backend only).
 * Customers always see the same ONECAB payment flow.
 */
export const SERVICE_AREA_PROVIDER_ROUTING_EXAMPLES = {
  "milton-keynes": { collection: "revolut", payout: "revolut" },
  london: { collection: "unavailable", payout: "unavailable" },  // provider retired
  kenya: { collection: "flutterwave", payout: "flutterwave" },
  ghana: { collection: "paystack", payout: "paystack" },
  somalia: { collection: "waafi", payout: "waafi", mobile_wallet: "evc_plus" },
  uganda: { collection: "mtn_mobile_money", payout: "mtn_mobile_money" },
  ethiopia: { collection: "telebirr", payout: "telebirr" },
} as const;


export const DRIVER_PAYOUT_ROUTING_EXAMPLES = {
  "milton-keynes": "revolut",
  kenya: "flutterwave",
  somalia: "waafi",
  ghana: "paystack",
} as const;


/** Saved cards belong to the ONECAB account; vault tokens are per provider. */
export const SAVED_CARDS_PLATFORM_RULE =
  "Saved Cards are an ONECAB platform feature. Backend stores provider-specific tokens; customers see one unified Saved Cards experience.";


/** Production default — weekly automated payout batches. */
export const DRIVER_PAYOUT_AUTOMATED_IS_PRODUCTION_DEFAULT = true;


export type OnecabPaymentProductionRule = (typeof ONECAB_PAYMENT_PRODUCTION_RULES)[number];


export const CUSTOMER_PAYMENT_UNAVAILABLE =
  "Payment methods are unavailable right now. Please try again.";


export const CUSTOMER_PAYMENT_NOT_CONFIGURED =
  "Payment options have not been configured for this area. Please contact support.";


export const CUSTOMER_DIGITAL_PAYMENTS_NOT_CONFIGURED =
  "Digital payments are not configured for this area. Please contact support.";


export const CUSTOMER_BOOKING_PAYMENTS_NOT_READY =
  "Digital payments are not ready for this area yet. Please contact support.";


export const CUSTOMER_SAVED_CARDS_SECTION_TITLE = "SAVED PAYMENT METHODS";


export const CUSTOMER_SAVED_CARDS_EMPTY =
  "Save a card to pay for rides without entering details each time.";


export const CUSTOMER_SAVED_CARD_SETUP_PROMPT =
  "Save a payment method for this area to use one-tap checkout on future rides.";


export const CUSTOMER_SAVE_CARD_DURING_CHECKOUT =
  "Save a payment method during checkout for faster payment next time.";


// ─── Admin / ops copy (internal — never shown to riders or drivers) ──────────

export const ADMIN_READINESS_VAULT_PENDING = "Vault pending";

export const ADMIN_READINESS_ADAPTER_UNAVAILABLE = "Adapter unavailable";

export const ADMIN_READINESS_NOT_CONFIGURED = "Not configured";


export const ADMIN_DRIVER_PAYOUT_AUTOMATED_DEFAULT_LABEL = "Automated payout (production default)";

export const ADMIN_DRIVER_PAYOUT_MANUAL_EXCEPTION_LABEL =
  "Manual payout — ops exceptions only (failed payout, compliance, adjustment, emergency)";


export const ADMIN_WEEKLY_MANUAL_PAYOUT_FORBIDDEN =
  "Do not manually process weekly driver payouts at scale — use automated payout batches.";


/** Reject customer/driver copy that leaks provider implementation. */
export function containsForbiddenProviderCopy(text: string): boolean {
  const lower = text.trim().toLowerCase();
  return FORBIDDEN_CUSTOMER_PROVIDER_COPY.some((phrase) => lower.includes(phrase));
}


export function customerPaymentMethodLabel(
  method: OnecabCustomerPaymentMethod,
): string {
  return CUSTOMER_PAYMENT_METHOD_LABELS[method];
}


export function isManualPayoutAllowedReason(
  reason: string | null | undefined,
): reason is ManualPayoutReason {
  return DRIVER_PAYOUT_MANUAL_EXCEPTION_REASONS.includes(reason as ManualPayoutReason);
}


export const PAYMENT_ROUTING_PIPELINE: readonly PaymentRoutingStep[] = [
  "customer_selects_method",
  "resolve_service_area",
  "resolve_payment_provider",
  "route_to_adapter",
  "complete_payment",
];


export const SAVED_CARD_BOOKING_PIPELINE: readonly SavedCardBookingFlow[] = [
  "detect_service_area",
  "select_payment_provider",
  "use_provider_token",
  "tokenize_once_if_missing",
  "reuse_on_future_bookings",
];
