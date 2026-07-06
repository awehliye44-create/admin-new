/** Classify money-movement mismatches for Financial Reconciliation → Alerts (8 spec types only). */

export type FinanceMismatchInput = {
  kind?: string;
  message?: string | null;
  reference_id?: string | null;
};

export type FinanceAlertItem = {
  id: string;
  label: string;
  detail: string;
  severity: 'destructive' | 'default';
};

/** Spec alert types — no other labels may surface in Alerts tab. */
export const FINANCE_ALERT_SPEC_LABELS = [
  'Provider without Ledger',
  'Ledger without Provider',
  'Settlement mismatch',
  'Capture mismatch',
  'Duplicate payout',
  'Negative wallet',
  'Failed recovery',
  'Webhook failure',
] as const;

export type FinanceAlertSpecLabel = (typeof FINANCE_ALERT_SPEC_LABELS)[number];

function msg(m: FinanceMismatchInput): string {
  return String(m.message ?? '');
}

function lowerMsg(m: FinanceMismatchInput): string {
  return msg(m).toLowerCase();
}

export function isFailedRecoveryMismatch(m: FinanceMismatchInput): boolean {
  const kind = String(m.kind ?? '').toLowerCase();
  const text = lowerMsg(m);
  if (kind === 'failed_recovery' || kind === 'recovery_failed') return true;
  if (text.includes('failed recovery') || text.includes('recovery failed')) return true;
  return text.includes('recovery') && (text.includes('failed') || text.includes('fail'));
}

export function classifyFinanceMismatch(m: FinanceMismatchInput): FinanceAlertItem | null {
  const kind = String(m.kind ?? '').toLowerCase();
  const text = lowerMsg(m);
  const ref = m.reference_id ?? 'unknown';
  const detail = msg(m) || 'Reconciliation mismatch';

  if (kind === 'trip_capture') {
    return { id: `cap-${ref}`, label: 'Capture mismatch', detail, severity: 'destructive' };
  }

  if (kind === 'payout') {
    if (text.includes('no matching driver_wallet_ledger') || text.includes('stripe payout paid but no matching')) {
      return { id: `swl-${ref}`, label: 'Provider without Ledger', detail, severity: 'destructive' };
    }
    if (text.includes('does not match driver wallet ledger')) {
      return { id: `lws-${ref}`, label: 'Ledger without Provider', detail, severity: 'destructive' };
    }
    if (text.includes('duplicate payout')) {
      return { id: `dup-payout-${ref}`, label: 'Duplicate payout', detail, severity: 'destructive' };
    }
    return null;
  }

  if (kind === 'account_balance' && text.includes('negative wallet')) {
    return { id: `neg-${ref}`, label: 'Negative wallet', detail, severity: 'destructive' };
  }

  if (text.includes('stripe without ledger') || text.includes('stripe payout without ledger')) {
    return { id: `swl-${ref}`, label: 'Provider without Ledger', detail, severity: 'destructive' };
  }
  if (text.includes('ledger without stripe')) {
    return { id: `lws-${ref}`, label: 'Ledger without Provider', detail, severity: 'destructive' };
  }
  if (text.includes('capture mismatch') || (text.includes('capture') && text.includes('mismatch'))) {
    return { id: `cap-${ref}`, label: 'Capture mismatch', detail, severity: 'destructive' };
  }
  if (text.includes('duplicate payout')) {
    return { id: `dup-payout-${ref}`, label: 'Duplicate payout', detail, severity: 'destructive' };
  }
  if (text.includes('negative wallet')) {
    return { id: `neg-${ref}`, label: 'Negative wallet', detail, severity: 'destructive' };
  }
  if (isFailedRecoveryMismatch(m)) {
    return { id: `rec-${ref}`, label: 'Failed recovery', detail, severity: 'destructive' };
  }
  if (text.includes('webhook') && (text.includes('fail') || text.includes('error') || text.includes('unhealthy'))) {
    return { id: `wh-${ref}`, label: 'Webhook failure', detail, severity: 'destructive' };
  }

  return null;
}
