/**
 * Provider settlement warning presentation helpers (pure).
 */

const INFORMATIONAL_WARNINGS = new Set<string>([
  "SEPARATE_CHARGE_TRANSFER_USED_NO_APPLICATION_FEE_OBJECT",
  "MANUAL_BANK_SETTLEMENT",
  "PROVIDER_SETTLEMENT_EVIDENCE_DEFERRED",
]);

export type SettlementWarningSeverity = "none" | "info" | "error";

export function isInformationalSettlementWarning(
  warning: string | null | undefined,
): boolean {
  const key = String(warning ?? "").trim().toUpperCase();
  if (!key) return false;
  return INFORMATIONAL_WARNINGS.has(key);
}

export function getSettlementWarningSeverity(
  verified: boolean,
  warning: string | null | undefined,
): SettlementWarningSeverity {
  const key = String(warning ?? "").trim();
  if (!key) return verified ? "none" : "error";
  if (isInformationalSettlementWarning(key)) return "info";
  return verified ? "info" : "error";
}

export function formatSettlementWarning(
  warning: string | null | undefined,
): string | null {
  const key = String(warning ?? "").trim();
  if (!key) return null;
  return key
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/^./, (c) => c.toUpperCase());
}
