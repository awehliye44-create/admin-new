/**
 * Provider-neutral payment method SSOT — admin UI labels.
 * Readiness payloads come from admin-service-area-digital-payment-methods edge.
 */

export type PaymentMethodKind =
  | "card"
  | "saved_card"
  | "apple_pay"
  | "google_pay"
  | "mobile_wallet"
  | "pay_by_bank"
  | "onecab_wallet";

export type MethodReadinessState =
  | "configured"
  | "not_configured"
  | "provider_unsupported"
  | "not_implemented"
  | "test"
  | "live";

export const PAYMENT_METHOD_ADMIN_LABELS: Record<PaymentMethodKind, string> = {
  card: "Card",
  saved_card: "Saved card",
  apple_pay: "Apple Pay",
  google_pay: "Google Pay",
  mobile_wallet: "Mobile wallet",
  pay_by_bank: "Pay by bank",
  onecab_wallet: "ONECAB Wallet",
};

export const PAYMENT_METHOD_TOGGLE_FIELDS: Record<PaymentMethodKind, string> = {
  card: "card_enabled",
  saved_card: "saved_card_enabled",
  apple_pay: "apple_pay_enabled",
  google_pay: "google_pay_enabled",
  mobile_wallet: "mobile_wallet_enabled",
  pay_by_bank: "pay_by_bank_enabled",
  onecab_wallet: "wallet_enabled",
};

export function readinessBadgeLabel(
  state: MethodReadinessState,
  _message?: string | null,
): string {
  switch (state) {
    case "live":
      return "Live";
    case "test":
      return "Test";
    case "configured":
      return "Configured";
    case "not_implemented":
      return "Vault pending";
    case "provider_unsupported":
      return "Provider unsupported";
    case "not_configured":
      return "Not configured";
  }
}

export function readinessBadgeClass(state: MethodReadinessState): string {
  switch (state) {
    case "live":
    case "configured":
      return "text-green-700 border-green-500/40 bg-green-50";
    case "test":
      return "text-blue-700 border-blue-500/40 bg-blue-50";
    case "not_implemented":
    case "provider_unsupported":
      return "text-amber-700 border-amber-500/40 bg-amber-50";
    case "not_configured":
      return "text-muted-foreground border-border bg-muted/40";
  }
}

export function isMethodToggleDisabled(
  readiness: MethodReadinessState,
  isSaving: boolean,
): boolean {
  return (
    isSaving
    || readiness === "provider_unsupported"
    || readiness === "not_implemented"
  );
}

export function payoutAdapterDisplayLabel(
  payoutAdapterStatus: string | null | undefined,
  payoutAutomation: string | null | undefined,
): string {
  if (payoutAutomation === "manual_ready") return "Manual payout ready";
  if (payoutAutomation === "automated_ready") return "Automated payout ready";
  if (payoutAdapterStatus === "live") return "Live";
  if (payoutAdapterStatus === "not_implemented") return "Not implemented";
  if (payoutAdapterStatus === "manual_ready") return "Manual payout ready";
  return payoutAdapterStatus ?? "Unknown";
}
