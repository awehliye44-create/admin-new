/** Human-readable payout status — bank arrival is separate from ledger record. */

const STATUS_LABELS: Record<string, string> = {
  created: 'Created',
  pending: 'Pending',
  processing: 'Pending',
  in_transit: 'In transit',
  completed: 'Paid',
  paid: 'Paid',
  failed: 'Failed',
  ledger_sync_failed: 'Failed',
  returned_to_wallet: 'Returned to wallet',
};

export function formatPayoutDisplayStatus(status: string): string {
  const normalized = status.trim().toLowerCase().replace(/\s+/g, '_');
  return STATUS_LABELS[normalized] ?? status;
}
