/** Driver-visible wallet transaction titles. */

export const WALLET_TRIPS_TAB_LEDGER_TYPES = [
  "TRIP_EARNING_NET",
  "DRIVER_TIP_CREDIT",
  "CASH_COMMISSION_DEBT",
  "DEBT_RECOVERY",
  "REFUND_DEBIT",
] as const;

const TITLES: Record<string, string> = {
  TRIP_EARNING_NET: "Card trip earning",
  DRIVER_TIP_CREDIT: "Passenger tip",
  CASH_COMMISSION_DEBT: "Cash trip commission",
  DEBT_RECOVERY: "Debt recovery",
  REFUND_DEBIT: "Refund",
  WEEKLY_PAYOUT: "Weekly payout",
  EARLY_CASHOUT: "Instant cash out",
  CASHOUT_FEE: "Cash-out fee",
  ADJUSTMENT: "Adjustment",
  MANUAL_ADJUSTMENT: "Manual adjustment",
  ADMIN_WALLET_CREDIT: "ONECAB adjustment",
  ADMIN_WALLET_DEBIT: "ONECAB adjustment",
  CHARGEBACK_DEBIT: "Chargeback adjustment",
  BONUS: "Bonus",
};

export function walletTransactionDisplayTitle(type: string | null | undefined): string {
  const key = String(type ?? "").trim().toUpperCase();
  return TITLES[key] ?? "Wallet activity";
}
