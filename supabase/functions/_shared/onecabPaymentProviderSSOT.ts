/**
 * ONECAB Payment Provider SSOT — platform rules (pure, no I/O).
 *
 * Principle: the service area determines the payment provider. Customers and
 * drivers never select or see the provider — backend routes transparently.
 *
 * Keep in sync:
 * - docs/ONECAB_PAYMENT_PROVIDER_SSOT.md
 * - supabase/functions/_shared/onecabPaymentProviderSSOT.ts
 * - admin-new/shared/onecabPaymentProviderSSOT.ts
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

/** Phrases that must never appear in customer or driver UI. */
export const FORBIDDEN_CUSTOMER_PROVIDER_COPY = [
  "provider unsupported",
  "provider only",
  "revolut only",
  "via provider",
  "via revolut",
  "card via revolut",
  "card via provider",
  "provider area",
  "revolut area",
  "payment provider",
] as const;

export type ManualPayoutReason =
  | "failed_payout"
  | "compliance_review"
  | "manual_adjustment"
  | "emergency_intervention";

/** Manual payout is ops-only; not the weekly driver settlement path. */
export const DRIVER_PAYOUT_MANUAL_EXCEPTION_REASONS: readonly ManualPayoutReason[] = [
  "failed_payout",
  "compliance_review",
  "manual_adjustment",
  "emergency_intervention",
];

/** Canonical production rules — see docs/ONECAB_PAYMENT_PROVIDER_SSOT.md */
export const ONECAB_PAYMENT_PRODUCTION_RULES = [
  "backend_is_ssot",
  "service_area_determines_providers",
  "customers_drivers_never_see_provider",
  "saved_cards_platform_with_per_provider_tokens",
  "auto_enable_wallets_when_adapter_supports",
  "identical_customer_ux_transparent_routing",
] as const;

// ─── Customer-safe copy (never names a payment provider) ─────────────────────

export const CUSTOMER_PAYMENT_METHOD_LABELS: Record<OnecabCustomerPaymentMethod, string> = {
  card: "Card",
  saved_card: "Saved card",
  apple_pay: "Apple Pay",
  google_pay: "Google Pay",
  mobile_wallet: "Mobile wallet",
  pay_by_bank: "Pay by bank",
  onecab_wallet: "ONECAB Wallet",
};
export const ADMIN_SAVED_CARD_VAULT_PENDING_MSG =
  "Save-card vault pending for this area's payment adapter.";
export const ADMIN_PAY_BY_BANK_NOT_ENABLED = "Pay by bank is not enabled for this area yet.";

export const ADMIN_DRIVER_PAYOUT_PENDING_AUTOMATION_MSG =
  "Automated payout not configured — add payout account credentials in Payment Providers.";

export const ADMIN_DRIVER_WALLET_MANUAL_INTERIM_MSG =
  "Payout account ready — weekly payouts handled by ONECAB until automated payout is enabled.";

/**
 * Booking routing SSOT (documentation + test helper).
 * Real routing: service_areas.payment_provider → paymentProviders adapter registry.
 */
export type PaymentRoutingStep =
  | "customer_selects_method"
  | "resolve_service_area"
  | "resolve_payment_provider"
  | "route_to_adapter"
  | "complete_payment";

export type SavedCardBookingFlow =
  | "detect_service_area"
  | "select_payment_provider"
  | "use_provider_token"
  | "tokenize_once_if_missing"
  | "reuse_on_future_bookings";
