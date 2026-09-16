/**
 * Payout Ledger — active vs history ownership (read-model only).
 * Completed payouts must never appear in active tabs, chips, or aggregate counts.
 */
import {
  DRIVER_PAYOUT_ITEM_DISPLAY,
  isDriverPayoutItemCompleted,
  type DriverPayoutItemDisplayStatus,
} from './driverPayoutBatchDisplaySSOT.ts';

export type PayoutLedgerLifecycleView = 'active' | 'history';

const ACTIVE_RAW = new Set([
  'pending',
  'scheduled',
  'queued',
  'on_hold',
  'reserved',
  'reserving',
  'blocked_execution_disabled',
  'funds_reserved_execution_disabled',
  'processing',
  'in_progress',
  'submitted',
  'submitting',
  'pending_provider',
  'provider_submission_in_progress',
  'failed',
  'error',
  'declined',
  'action_required',
  'returned',
  'cancelled',
  'canceled',
  'reversed',
  'reverted',
]);

const ACTIVE_DISPLAY = new Set<DriverPayoutItemDisplayStatus>([
  DRIVER_PAYOUT_ITEM_DISPLAY.NOT_SUBMITTED,
  DRIVER_PAYOUT_ITEM_DISPLAY.RESERVED,
  DRIVER_PAYOUT_ITEM_DISPLAY.SUBMITTED,
  DRIVER_PAYOUT_ITEM_DISPLAY.FAILED,
  DRIVER_PAYOUT_ITEM_DISPLAY.DECLINED,
  DRIVER_PAYOUT_ITEM_DISPLAY.UNKNOWN,
]);

export function resolvePayoutLedgerLifecycleView(args: {
  status?: string | null;
  display_status?: string | null;
  completed_at?: string | null;
}): PayoutLedgerLifecycleView {
  const display = String(args.display_status ?? '').trim().toUpperCase();
  if (display === DRIVER_PAYOUT_ITEM_DISPLAY.COMPLETED) return 'history';
  if (isDriverPayoutItemCompleted(args.status)) return 'history';
  if (args.completed_at) return 'history';
  const raw = String(args.status ?? '').trim().toLowerCase();
  if (ACTIVE_RAW.has(raw)) return 'active';
  if (display && ACTIVE_DISPLAY.has(display as DriverPayoutItemDisplayStatus)) return 'active';
  return 'active';
}

export function isPayoutLedgerActiveItem(args: {
  status?: string | null;
  display_status?: string | null;
  completed_at?: string | null;
}): boolean {
  return resolvePayoutLedgerLifecycleView(args) === 'active';
}

export function isPayoutLedgerHistoryItem(args: {
  status?: string | null;
  display_status?: string | null;
  completed_at?: string | null;
}): boolean {
  return resolvePayoutLedgerLifecycleView(args) === 'history';
}

/** Map list tab to active/history lifecycle filter. */
export function payoutLedgerTabLifecycleFilter(tab: string): PayoutLedgerLifecycleView | null {
  const t = tab.toLowerCase();
  if (t === 'overview' || t === 'driver_payouts' || t === 'scheduled' || t === 'processing' || t === 'failed' || t === 'failed_transfers' || t === 'failures' || t === 'returned_cancelled') {
    return 'active';
  }
  if (t === 'history' || t === 'completed' || t === 'batch_history' || t === 'audit_history') {
    return 'history';
  }
  return null;
}

export function itemMatchesPayoutLedgerLifecycleTab(args: {
  tab: string;
  status?: string | null;
  display_status?: string | null;
  completed_at?: string | null;
}): boolean {
  const lifecycle = payoutLedgerTabLifecycleFilter(args.tab);
  if (!lifecycle) return true;
  const view = resolvePayoutLedgerLifecycleView(args);
  if (lifecycle === 'active') return view === 'active';
  return view === 'history';
}

/** Narrow tab filters within the active lifecycle bucket. */
export function itemMatchesPayoutLedgerStatusTab(args: {
  tab: string;
  status?: string | null;
  display_status?: string | null;
}): boolean {
  const t = args.tab.toLowerCase();
  const raw = String(args.status ?? '').trim().toLowerCase();
  const display = String(args.display_status ?? '').trim().toUpperCase();

  if (t === 'scheduled') {
    return ['pending', 'scheduled', 'queued', 'on_hold'].includes(raw)
      || display === DRIVER_PAYOUT_ITEM_DISPLAY.NOT_SUBMITTED
      || display === DRIVER_PAYOUT_ITEM_DISPLAY.RESERVED;
  }
  if (t === 'processing') {
    return ['processing', 'in_progress', 'submitted', 'submitting', 'pending_provider', 'provider_submission_in_progress'].includes(raw)
      || display === DRIVER_PAYOUT_ITEM_DISPLAY.SUBMITTED;
  }
  if (t === 'failed' || t === 'failed_transfers' || t === 'failures') {
    return ['failed', 'error', 'declined', 'ledger_sync_failed'].includes(raw)
      || display === DRIVER_PAYOUT_ITEM_DISPLAY.FAILED
      || display === DRIVER_PAYOUT_ITEM_DISPLAY.DECLINED;
  }
  if (t === 'completed' || t === 'history') {
    return isDriverPayoutItemCompleted(args.status)
      || display === DRIVER_PAYOUT_ITEM_DISPLAY.COMPLETED;
  }
  if (t === 'returned_cancelled') {
    return ['returned', 'cancelled', 'canceled', 'reversed', 'reverted'].includes(raw);
  }
  return true;
}

export const PAYOUT_LEDGER_ACTIVE_CHIP_LABELS = {
  scheduled: 'Scheduled',
  reserved: 'Reserved',
  processing: 'Processing',
  failed: 'Failed',
  action_required: 'Action required',
} as const;

export const PAYOUT_LEDGER_HISTORY_CHIP_LABELS = {
  completed_weekly: 'Completed weekly',
  completed_instant: 'Completed instant',
  transfer_amount: 'Transfer amount',
  fee: 'Fee',
  provider_transfer_id: 'Provider transfer ID',
  completion_date: 'Completion date',
  wallet_allocations: 'Wallet allocations',
} as const;
