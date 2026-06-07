const INFORMATIONAL_WARNING_CODES = new Set([
  'SEPARATE_CHARGE_TRANSFER_USED_NO_APPLICATION_FEE_OBJECT',
  'NO_DRIVER_CONNECT_ACCOUNT_PLATFORM_RETAINED_FULL_CHARGE_MANUAL_PAYOUT_REQUIRED',
  'NO_DRIVER_CONNECT_ACCOUNT_PLATFORM_CHARGE_ONLY_UNTIL_MANUAL_PAYOUT',
]);

const WARNING_LABELS: Record<string, string> = {
  SEPARATE_CHARGE_TRANSFER_USED_NO_APPLICATION_FEE_OBJECT:
    'Driver payout verified via separate Connect transfer (no application fee object on charge).',
  NO_DRIVER_CONNECT_ACCOUNT_PLATFORM_RETAINED_FULL_CHARGE_MANUAL_PAYOUT_REQUIRED:
    'No driver Connect account — platform retained the full charge; manual driver payout required.',
  NO_DRIVER_CONNECT_ACCOUNT_PLATFORM_CHARGE_ONLY_UNTIL_MANUAL_PAYOUT:
    'No driver Connect account at booking — platform charge only until manual payout.',
};

export type SettlementWarningSeverity = 'info' | 'error' | null;

export function getSettlementWarningSeverity(
  verified: boolean,
  warning: string | null,
): SettlementWarningSeverity {
  if (!warning) return null;
  if (verified && INFORMATIONAL_WARNING_CODES.has(warning)) return 'info';
  if (!verified) return 'error';
  if (warning.startsWith('STRIPE_SETTLEMENT_NOT_VERIFIED')) return 'error';
  if (
    warning.startsWith('DESTINATION_CHARGE_APP_FEE_MISMATCH') ||
    warning.startsWith('SEPARATE_TRANSFER_MISMATCH')
  ) {
    return 'error';
  }
  return verified ? 'info' : 'error';
}

export function formatSettlementWarning(warning: string | null): string | null {
  if (!warning) return null;
  return WARNING_LABELS[warning] ?? warning;
}

export function isInformationalSettlementWarning(warning: string | null): boolean {
  return !!warning && INFORMATIONAL_WARNING_CODES.has(warning);
}
