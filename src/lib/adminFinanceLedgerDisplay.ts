/**
 * Admin finance ledger display — system-wide money movement labels and filters.
 * Synced from drive-hub-buddy/shared/adminFinanceLedgerDisplay.ts (backend authority).
 */

export type AdminFinanceLedgerFilter =
  | 'all'
  | 'customer_payments'
  | 'driver_earnings'
  | 'onecab_commission'
  | 'debt_recovery'
  | 'payouts'
  | 'refunds'
  | 'adjustments'
  | 'bonus'
  | 'discounts';

export type AdminFinanceParty = 'customer' | 'driver' | 'ONECAB' | 'Stripe' | 'system';

export const ADMIN_FINANCE_FILTER_LABELS: Record<AdminFinanceLedgerFilter, string> = {
  all: 'All',
  customer_payments: 'Customer payments',
  driver_earnings: 'Driver earnings',
  onecab_commission: 'ONECAB commission',
  debt_recovery: 'Debt recovery',
  payouts: 'Payouts',
  refunds: 'Refunds',
  adjustments: 'Adjustments',
  bonus: 'Bonus',
  discounts: 'Discounts',
};

/** Cash commission owed, recovery debits, and ONECAB mirror credits — full debt lifecycle. */
export const ADMIN_DEBT_RECOVERY_LEDGER_TYPES = [
  'CASH_COMMISSION_DEBT',
  'DEBT_RECOVERY',
  'COMMISSION_RECOVERED',
] as const;

export type AdminDebtRecoveryLedgerType = (typeof ADMIN_DEBT_RECOVERY_LEDGER_TYPES)[number];

export const ADMIN_ONECAB_COMMISSION_LEDGER_TYPES = [
  'PLATFORM_COMMISSION',
  'CASH_COMMISSION_DEBT',
  'COMMISSION_RECOVERED',
] as const;

const LEDGER_TYPE_META: Record<string, {
  label: string;
  party: AdminFinanceParty;
  filter: AdminFinanceLedgerFilter;
}> = {
  TRIP_EARNING_NET: { label: 'Driver net earning', party: 'driver', filter: 'driver_earnings' },
  DRIVER_TIP_CREDIT: { label: 'Tip', party: 'driver', filter: 'driver_earnings' },
  CASH_TRIP_EARNING: { label: 'Cash trip (pass-through)', party: 'driver', filter: 'driver_earnings' },
  CASH_COMMISSION_DEBT: {
    label: 'Cash trip commission debit',
    party: 'driver',
    filter: 'debt_recovery',
  },
  PLATFORM_COMMISSION: { label: 'ONECAB commission', party: 'ONECAB', filter: 'onecab_commission' },
  DEBT_RECOVERY: {
    label: 'Debt recovery debit',
    party: 'driver',
    filter: 'debt_recovery',
  },
  COMMISSION_RECOVERED: {
    label: 'Debt recovery credit (ONECAB)',
    party: 'ONECAB',
    filter: 'debt_recovery',
  },
  WEEKLY_PAYOUT: { label: 'Weekly payout', party: 'driver', filter: 'payouts' },
  EARLY_CASHOUT: { label: 'Instant cash out', party: 'driver', filter: 'payouts' },
  MANUAL_PAYOUT: { label: 'Manual payout', party: 'driver', filter: 'payouts' },
  PAYOUT: { label: 'Payout', party: 'driver', filter: 'payouts' },
  PAYOUT_CREATED: { label: 'Payout created', party: 'system', filter: 'payouts' },
  CASHOUT_FEE: { label: 'Payout fee', party: 'ONECAB', filter: 'payouts' },
  ADJUSTMENT: { label: 'Adjustment', party: 'driver', filter: 'adjustments' },
  MANUAL_ADJUSTMENT: { label: 'Manual adjustment', party: 'driver', filter: 'adjustments' },
  CHARGEBACK_DEBIT: { label: 'Chargeback adjustment', party: 'driver', filter: 'adjustments' },
  BONUS: { label: 'Bonus', party: 'driver', filter: 'adjustments' },
  REFUND_DEBIT: { label: 'Refund', party: 'customer', filter: 'refunds' },
  LEDGER_REVERSAL: { label: 'Ledger reversal', party: 'system', filter: 'adjustments' },
  PAYOUT_FAILED_RETURN: { label: 'Payout reversal', party: 'driver', filter: 'payouts' },
};

export function adminFinanceLedgerTypeMeta(type: string): {
  label: string;
  party: AdminFinanceParty;
  filter: AdminFinanceLedgerFilter;
} {
  return LEDGER_TYPE_META[type] ?? {
    label: type,
    party: 'system',
    filter: 'all',
  };
}

export function adminFinanceLedgerMatchesFilter(
  type: string,
  filter: AdminFinanceLedgerFilter,
): boolean {
  if (filter === 'all') return true;
  if (filter === 'debt_recovery') {
    return (ADMIN_DEBT_RECOVERY_LEDGER_TYPES as readonly string[]).includes(type);
  }
  if (filter === 'onecab_commission') {
    return (ADMIN_ONECAB_COMMISSION_LEDGER_TYPES as readonly string[]).includes(type);
  }
  if (filter === 'bonus') {
    return type === 'BONUS';
  }
  const meta = adminFinanceLedgerTypeMeta(type);
  return meta.filter === filter;
}

export function adminFinanceLedgerDirection(amountPence: number): 'credit' | 'debit' {
  return amountPence >= 0 ? 'credit' : 'debit';
}

export function isAdminDebtRecoveryDebit(type: string, amountPence: number): boolean {
  return type === 'CASH_COMMISSION_DEBT' || type === 'DEBT_RECOVERY' || amountPence < 0;
}

export const ADMIN_CUSTOMER_PAYMENT_ROW_TYPE = 'CUSTOMER_PAYMENT_CAPTURED';

export function adminCustomerPaymentMeta(): {
  label: string;
  party: AdminFinanceParty;
  filter: AdminFinanceLedgerFilter;
} {
  return {
    label: 'Customer payment',
    party: 'customer',
    filter: 'customer_payments',
  };
}

export const ADMIN_DISCOUNT_ROW_TYPE = 'TRIP_DISCOUNT';

export function adminDiscountMeta(): {
  label: string;
  party: AdminFinanceParty;
  filter: AdminFinanceLedgerFilter;
} {
  return {
    label: 'Trip discount',
    party: 'customer',
    filter: 'discounts',
  };
}
