/**
 * ONECAB Payment Provider SSOT — platform rules (pure, no I/O).
 *
 * Principle: the service area determines the payment provider. Customers and
 * drivers never select or see the provider — backend routes transparently.
 *
 * Keep in sync:
 * - docs/ONECAB_PAYMENT_PROVIDER_SSOT.md
 * - supabase/functions/_shared/onecabPaymentProviderSSOT.ts
 * - admin-new (ops labels only — never customer copy)
 */

/** Standard ONECAB customer payment methods (global product surface). */
export const ONECAB_CUSTOMER_PAYMENT_METHODS = [
  "card",
  "saved_card",
  "apple_pay",
  "google_pay",
  "mobile_wallet",
  "pay_by_bank",
  "onecab_wallet",
] as const;

export type OnecabCustomerPaymentMethod = (typeof ONECAB_CUSTOMER_PAYMENT_METHODS)[number];

/**
 * Reference routing — service area → collection/payout adapter (backend only).
 * Customers always see the same ONECAB payment flow.
 */
export const SERVICE_AREA_PROVIDER_ROUTING_EXAMPLES = {
  "milton-keynes": { collection: "revolut", payout: "revolut" },
  london: { collection: "stripe", payout: "stripe" },
  kenya: { collection: "flutterwave", payout: "flutterwave" },
  ghana: { collection: "paystack", payout: "paystack" },
  somalia: { collection: "waafi", payout: "waafi" },
  uganda: { collection: "mtn_mobile_money", payout: "mtn_mobile_money" },
  ethiopia: { collection: "telebirr", payout: "telebirr" },
} as const;

/** Saved cards belong to the ONECAB account; vault tokens are per provider. */
export const SAVED_CARDS_PLATFORM_RULE =
  "Saved Cards are an ONECAB platform feature. Backend stores provider-specific tokens; customers see one unified Saved Cards experience.";

/** Phrases that must never appear in customer or driver UI. */
export const FORBIDDEN_CUSTOMER_PROVIDER_COPY = [
  "provider unsupported",
  "stripe only",
  "revolut only",
  "via stripe",
  "via revolut",
  "stripe area",
  "revolut area",
  "payment provider",
] as const;

export type ManualPayoutReason =
  | "failed_payout"
  | "compliance_review"
  | "manual_adjustment"
  | "emergency_intervention";

/** Production default — weekly automated payout batches. */
export const DRIVER_PAYOUT_AUTOMATED_IS_PRODUCTION_DEFAULT = true;

/** Manual payout is ops-only; not the weekly driver settlement path. */
export const DRIVER_PAYOUT_MANUAL_EXCEPTION_REASONS: readonly ManualPayoutReason[] = [
  "failed_payout",
  "compliance_review",
  "manual_adjustment",
  "emergency_intervention",
];

// ─── Customer-safe copy (never names a payment provider) ─────────────────────

export const CUSTOMER_PAYMENT_METHOD_LABELS: Record<
  Exclude<OnecabCustomerPaymentMethod, "onecab_wallet"> | "onecab_wallet",
  string
> = {
  card: "Card",
  saved_card: "Saved card",
  apple_pay: "Apple Pay",
  google_pay: "Google Pay",
  mobile_wallet: "Mobile wallet",
  pay_by_bank: "Pay by bank",
  onecab_wallet: "ONECAB Wallet",
};

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

// ─── Admin / ops copy (internal — may reference adapters, never shown to riders) ───

export const ADMIN_READINESS_VAULT_PENDING = "Vault pending";
export const ADMIN_READINESS_ADAPTER_UNAVAILABLE = "Adapter unavailable";
export const ADMIN_READINESS_NOT_CONFIGURED = "Not configured";
export const ADMIN_SAVED_CARD_VAULT_PENDING_MSG =
  "Save-card vault pending for this area's payment adapter.";
export const ADMIN_PAY_BY_BANK_NOT_ENABLED = "Pay by bank is not enabled for this area yet.";

export const ADMIN_DRIVER_PAYOUT_AUTOMATED_DEFAULT_LABEL = "Automated payout (production default)";
export const ADMIN_DRIVER_PAYOUT_MANUAL_EXCEPTION_LABEL =
  "Manual payout — ops exceptions only (failed payout, compliance, adjustment, emergency)";

export const ADMIN_DRIVER_PAYOUT_PENDING_AUTOMATION_MSG =
  "Automated payout not configured — add payout account credentials in Payment Providers.";

export const ADMIN_DRIVER_WALLET_MANUAL_INTERIM_MSG =
  "Payout account ready — weekly payouts handled by ONECAB until automated payout is enabled.";

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

/**
 * Booking routing SSOT (documentation + test helper).
 * Real routing lives in payment adapter registry + service_areas.payment_provider.
 */
export type PaymentRoutingStep =
  | "customer_selects_method"
  | "resolve_service_area"
  | "resolve_payment_provider"
  | "route_to_adapter"
  | "complete_payment";

export const PAYMENT_ROUTING_PIPELINE: readonly PaymentRoutingStep[] = [
  "customer_selects_method",
  "resolve_service_area",
  "resolve_payment_provider",
  "route_to_adapter",
  "complete_payment",
];

export type SavedCardBookingFlow =
  | "detect_service_area"
  | "select_payment_provider"
  | "use_provider_token"
  | "tokenize_once_if_missing"
  | "reuse_on_future_bookings";

export const SAVED_CARD_BOOKING_PIPELINE: readonly SavedCardBookingFlow[] = [
  "detect_service_area",
  "select_payment_provider",
  "use_provider_token",
  "tokenize_once_if_missing",
  "reuse_on_future_bookings",
];
