import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatPence } from '@/hooks/useDriverWallet';
import type { StripeConnectPayoutHistoryRow } from '@/hooks/useMondayPayoutDiagnostics';
import { format, isValid, parseISO } from 'date-fns';

function formatAt(value: string | null | undefined): string {
  if (!value) return '—';
  const d = parseISO(value);
  if (!isValid(d)) return '—';
  return format(d, 'd MMM yyyy HH:mm');
}

export function StripeConnectPayoutHistoryTable({
  rows,
  currencyCode,
}: {
  rows: StripeConnectPayoutHistoryRow[];
  currencyCode: string;
}) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-4 text-center">
        No Stripe Connect bank payouts synced for this period yet.
      </p>
    );
  }

  return (
    <div className="rounded-md border overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Driver</TableHead>
            <TableHead>Payout ID</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Initiated</TableHead>
            <TableHead>Arrival</TableHead>
            <TableHead>Method</TableHead>
            <TableHead>Balance txn</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.payout_id}>
              <TableCell className="font-medium whitespace-nowrap">
                {row.driver_name ?? row.driver_id?.slice(0, 8) ?? '—'}
              </TableCell>
              <TableCell className="font-mono text-xs">{row.payout_id}</TableCell>
              <TableCell className="text-right font-semibold">
                {formatPence(row.amount_pence, row.currency ?? currencyCode)}
              </TableCell>
              <TableCell>
                <Badge variant={row.status === 'paid' ? 'default' : 'secondary'}>
                  {row.status}
                </Badge>
              </TableCell>
              <TableCell className="text-xs whitespace-nowrap">{formatAt(row.initiated_at)}</TableCell>
              <TableCell className="text-xs whitespace-nowrap">{formatAt(row.arrival_date)}</TableCell>
              <TableCell className="text-xs">{row.payout_method ?? '—'}</TableCell>
              <TableCell className="font-mono text-xs truncate max-w-[120px]" title={row.balance_transaction_id ?? undefined}>
                {row.balance_transaction_id?.slice(0, 14) ?? '—'}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
