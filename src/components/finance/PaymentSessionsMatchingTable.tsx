/**
 * Payment Sessions matching table — PS amounts only.
 * Amount reconciliation conclusions are owned by Financial Reconciliation.
 */
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { AdminPaymentSessionsMatchingRow } from '../../../shared/adminPaymentSessionsSSOT';
import { paymentSessionsUrl } from '../../../shared/adminPaymentSessionsSSOT';
import { isPaymentSessionsAmountsOnFrStatus } from '../../../shared/paymentSessionsTripMatchSSOT';
import { financeReconciliationTripUrl } from '@/lib/financialReconciliationRoutes';
import { formatNullablePence } from '@/lib/formatNullablePence';

/** @deprecated Prefer Financial Reconciliation for match conclusions. Kept for deep-link compatibility. */
export function PaymentSessionsMatchingTable({
  rows,
  currencyCode = 'GBP',
  onInspectProvider,
}: {
  rows: AdminPaymentSessionsMatchingRow[];
  currencyCode?: string;
  onInspectProvider?: (providerOrderId: string) => void;
}) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No matching rows in this window.</p>;
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Actual / Refunded / Authorised / Released = Payment Sessions.
        Amount reconciliation conclusions belong on Financial Reconciliation.
      </p>
      <div className="overflow-x-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Trip</TableHead>
            <TableHead>Payment Session</TableHead>
            <TableHead>Customer</TableHead>
            <TableHead>Actual Capture</TableHead>
            <TableHead>Refunded</TableHead>
            <TableHead>Authorised</TableHead>
            <TableHead>Released</TableHead>
            <TableHead>Presence</TableHead>
            <TableHead>Provider State</TableHead>
            <TableHead>Verification</TableHead>
            <TableHead>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="font-mono text-xs">
                {row.trip_code ?? (row.trip_id ? row.trip_id.slice(0, 8) : 'No linked trip')}
              </TableCell>
              <TableCell className="font-mono text-xs">
                {row.payment_session_id ? row.payment_session_id.slice(0, 8) : '—'}
              </TableCell>
              <TableCell className="text-xs">{row.customer_name ?? '—'}</TableCell>
              <TableCell className="text-xs tabular-nums">{formatNullablePence(row.actual_capture_pence, currencyCode)}</TableCell>
              <TableCell className="text-xs tabular-nums">
                {formatNullablePence(row.refunded_amount_pence, currencyCode)}
              </TableCell>
              <TableCell className="text-xs tabular-nums">{formatNullablePence(row.authorised_amount_pence, currencyCode)}</TableCell>
              <TableCell className="text-xs tabular-nums">{formatNullablePence(row.released_amount_pence, currencyCode)}</TableCell>
              <TableCell>
                {!isPaymentSessionsAmountsOnFrStatus(row.match_status) && row.match_status ? (
                  <Badge variant="secondary">{row.match_status}</Badge>
                ) : (
                  <span className="text-xs text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell className="text-xs">{row.provider_state ?? '—'}</TableCell>
              <TableCell className="text-xs">
                {row.provider_verification_status === 'STALE'
                  ? 'Cached / stale'
                  : (row.provider_verification_status ?? '—')}
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1">
                  {row.trip_id && (
                    <Button asChild size="sm" variant="outline">
                      <Link to={financeReconciliationTripUrl(row.trip_id, row.trip_code)}>
                        Financial Reconciliation
                      </Link>
                    </Button>
                  )}
                  {row.payment_session_id && (
                    <Button asChild size="sm" variant="outline">
                      <Link to={paymentSessionsUrl({
                        paymentSessionId: row.payment_session_id,
                      })}
                      >
                        Session
                      </Link>
                    </Button>
                  )}
                  {row.provider_order_id && onInspectProvider && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => onInspectProvider(row.provider_order_id!)}
                    >
                      Evidence
                    </Button>
                  )}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      </div>
    </div>
  );
}
