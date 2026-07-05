import type { TripAuditStatusBadge } from '@/hooks/useFinanceReconciliation';

export function reconciliationBadgeVariant(
  tone: TripAuditStatusBadge['tone'] | undefined,
): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (tone) {
    case 'green':
      return 'default';
    case 'red':
      return 'destructive';
    case 'yellow':
    case 'orange':
      return 'secondary';
    default:
      return 'outline';
  }
}
