/**
 * Formatting helpers for historical Stripe settlement warnings surfaced by
 * `admin-get-trip-payment-state`. Pure string utilities — no Stripe SDK,
 * no runtime settlement logic. New settlements go through Revolut helpers
 * in `_shared/revolutOrders.ts`.
 */

export type SettlementWarningSeverity = "info" | "warning" | "error";

const INFORMATIONAL_WARNINGS = new Set<string>([
  "SEPARATE_CHARGE_TRANSFER_USED_NO_APPLICATION_FEE_OBJECT",
]);

const ERROR_WARNINGS = new Set<string>([
  "STRIPE_SETTLEMENT_NOT_VERIFIED_NO_APPLICATION_FEE_OR_TRANSFER",
  "STRIPE_SETTLEMENT_UNVERIFIED",
]);

export function isInformationalSettlementWarning(warning: string | null | undefined): boolean {
  if (!warning) return false;
  return INFORMATIONAL_WARNINGS.has(warning);
}

export function getSettlementWarningSeverity(
  verified: boolean,
  warning: string | null | undefined,
): SettlementWarningSeverity {
  if (!warning) return verified ? "info" : "info";
  if (INFORMATIONAL_WARNINGS.has(warning)) return "info";
  if (ERROR_WARNINGS.has(warning)) return "error";
  return verified ? "info" : "warning";
}

export function formatSettlementWarning(warning: string | null | undefined): string | null {
  if (!warning) return null;
  switch (warning) {
    case "SEPARATE_CHARGE_TRANSFER_USED_NO_APPLICATION_FEE_OBJECT":
      return "Legacy separate-charge-transfer settlement (historical Stripe).";
    case "STRIPE_SETTLEMENT_NOT_VERIFIED_NO_APPLICATION_FEE_OR_TRANSFER":
      return "Stripe settlement could not be verified — no application fee or transfer recorded.";
    case "STRIPE_SETTLEMENT_UNVERIFIED":
      return "Stripe settlement is unverified.";
    default:
      return warning.replaceAll("_", " ").toLowerCase();
  }
}
