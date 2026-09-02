import { Fragment } from 'react';
import { Link } from 'react-router-dom';
import { format } from 'date-fns';
import { Loader2 } from 'lucide-react';
import { LoadingTimeout } from '@/components/LoadingTimeout';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { AdminPaymentSessionsListRow } from '../../../shared/adminPaymentSessionsSSOT';
import { isStaleUnverifiedAuthorisationRow } from '../../../shared/paymentSessionsOperationalChipsSSOT';
import { financeReconciliationTripUrl, tripSettlementRecoverUrl } from '@/lib/financialReconciliationRoutes';
import { formatAgeMinutes, formatNullablePence } from '@/lib/formatNullablePence';
import { PaymentSessionsRowActions } from '@/components/finance/PaymentSessionsRowActions';

export type PaymentSessionsListPanelProps = {
  rows: AdminPaymentSessionsListRow[];
  isLoading: boolean;
  isFetching: boolean;
  error: Error | null;
  filteredTotal: number;
  listOffset: number;
  pageLimit: number;
  hasMore: boolean;
  actingId: string | null;
  inspectingId: string | null;
  expandedId: string | null;
  inspectSnapshots: Record<string, Record<string, unknown>>;
  onExpandToggle: (id: string | null) => void;
  onRefetch: () => void;
  onPagePrev: () => void;
  onPageNext: () => void;
  onAction: (row: AdminPaymentSessionsListRow, action: 'release' | 'retry_release' | 'retry_recovery') => void;
  onRefund: (row: AdminPaymentSessionsListRow) => void;
  onInspect: (row: AdminPaymentSessionsListRow) => void;
  onRequestRecovery: (row: AdminPaymentSessionsListRow, mode?: 'collect_outstanding' | 'payment_link') => void;
  onAbandonRecovery: (row: AdminPaymentSessionsListRow) => void;
  onRefreshProvider: (row: AdminPaymentSessionsListRow) => void;
};

function statusLabel(row: AdminPaymentSessionsListRow): string {
  if (isStaleUnverifiedAuthorisationRow(row)) {
    return 'Authorisation expired/unverified';
  }
  return row.session_status_display
    ?? row.session_status_label
    ?? row.session_status
    ?? '—';
}

export function PaymentSessionsListPanel({
  rows,
  isLoading,
  isFetching,
  error,
  filteredTotal,
  listOffset,
  pageLimit,
  hasMore,
  actingId,
  inspectingId,
  expandedId,
  inspectSnapshots,
  onExpandToggle,
  onRefetch,
  onPagePrev,
  onPageNext,
  onAction,
  onRefund,
  onInspect,
  onRequestRecovery,
  onAbandonRecovery,
  onRefreshProvider,
}: PaymentSessionsListPanelProps) {
  const pageStart = filteredTotal === 0 ? 0 : listOffset + 1;
  const pageEnd = listOffset + rows.length;

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Payment Sessions failed to load</AlertTitle>
        <AlertDescription className="flex flex-wrap items-center gap-2">
          <span>{error.message}</span>
          <Button size="sm" variant="outline" onClick={onRefetch}>Retry</Button>
        </AlertDescription>
      </Alert>
    );
  }

  if (isLoading && rows.length === 0) {
    return (
      <LoadingTimeout
        isLoading
        sectionLabel="payment sessions"
        loadingText="Loading payment sessions…"
        onRetry={onRefetch}
      />
    );
  }

  if (rows.length === 0) {
    return (
      <Alert>
        <AlertTitle>No payment sessions match these filters.</AlertTitle>
      </Alert>
    );
  }

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Created</TableHead>
              <TableHead>Payment Session ID</TableHead>
              <TableHead>Trip</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Payment method</TableHead>
              <TableHead>Authorised</TableHead>
              <TableHead>Captured</TableHead>
              <TableHead>Released</TableHead>
              <TableHead>Refunded</TableHead>
              <TableHead>Provider fee</TableHead>
              <TableHead>Provider state</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const key = row.id;
              return (
                <Fragment key={key}>
                  <TableRow>
                    <TableCell className="whitespace-nowrap text-xs">
                      {format(new Date(row.created_at), 'dd MMM HH:mm')}
                    </TableCell>
                    <TableCell className="font-mono text-[11px]">
                      {row.payment_session_id
                        ? row.payment_session_id.slice(0, 8)
                        : row.orphan_payment_id
                        ? `orphan:${row.orphan_payment_id.slice(0, 8)}`
                        : '—'}
                    </TableCell>
                    <TableCell className="text-xs">
                      {row.trip_id ? (
                        <Link
                          className="underline"
                          to={tripSettlementRecoverUrl(row.trip_id, row.trip_code)}
                        >
                          {row.trip_code ?? row.trip_id.slice(0, 8)}
                        </Link>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell className="text-xs">
                      {row.customer_name ?? row.customer_email ?? row.customer_id?.slice(0, 8) ?? '—'}
                    </TableCell>
                    <TableCell className="text-xs">{row.payment_method ?? '—'}</TableCell>
                    <TableCell className="text-xs tabular-nums">
                      {formatNullablePence(row.authorised_amount_pence)}
                    </TableCell>
                    <TableCell className="text-xs tabular-nums">
                      {formatNullablePence(row.captured_amount_pence)}
                    </TableCell>
                    <TableCell className="text-xs tabular-nums">
                      {formatNullablePence(row.released_amount_pence)}
                    </TableCell>
                    <TableCell className="text-xs tabular-nums">
                      {formatNullablePence(row.refunded_amount_pence)}
                    </TableCell>
                    <TableCell className="text-xs tabular-nums">
                      {formatNullablePence(row.provider_processing_fee_pence)}
                    </TableCell>
                    <TableCell className="text-xs">{row.provider_state ?? '—'}</TableCell>
                    <TableCell className="text-xs">
                      <Badge variant="outline">{statusLabel(row)}</Badge>
                      {row.attention_class ? (
                        <div className="text-[10px] text-muted-foreground mt-0.5">{row.attention_class}</div>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <PaymentSessionsRowActions
                        row={row}
                        actingId={actingId}
                        inspectingId={inspectingId}
                        onAction={onAction}
                        onRefund={onRefund}
                        onInspect={onInspect}
                        onRequestRecovery={onRequestRecovery}
                        onAbandonRecovery={onAbandonRecovery}
                        onRefreshProvider={onRefreshProvider}
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        className="mt-1"
                        onClick={() => onExpandToggle(expandedId === key ? null : key)}
                      >
                        {expandedId === key ? 'Hide' : 'Evidence'}
                      </Button>
                    </TableCell>
                  </TableRow>
                  {expandedId === key && (
                    <TableRow>
                      <TableCell colSpan={13} className="bg-muted/40 text-xs">
                        <div className="space-y-2">
                          {row.authorised_amount_pence != null && Number(row.authorised_amount_pence) > 0 ? (
                            <div className="rounded border bg-background px-3 py-2">
                              <p className="text-muted-foreground">Authorised hold amount</p>
                              <p className="text-sm font-semibold tabular-nums">
                                {formatNullablePence(row.authorised_amount_pence)}
                              </p>
                              <p className="text-[11px] text-muted-foreground mt-0.5">
                                Not captured · Not revenue
                              </p>
                            </div>
                          ) : null}
                          <div className="flex flex-wrap gap-3 text-muted-foreground">
                            <span>order: {row.provider_order_id?.slice(0, 12) ?? '—'}</span>
                            <span>age: {formatAgeMinutes(row.age_minutes)}</span>
                            {row.trip_id ? (
                              <Link className="underline" to={financeReconciliationTripUrl(row.trip_id, row.trip_code)}>
                                Driver credit audit → Financial Reconciliation
                              </Link>
                            ) : null}
                          </div>
                          <pre className="whitespace-pre-wrap text-[11px]">
                            {JSON.stringify(
                              {
                                payment_session_id: row.payment_session_id,
                                provider_order_id: row.provider_order_id,
                                authorised_amount_pence: row.authorised_amount_pence,
                                captured_amount_pence: row.captured_amount_pence,
                                released_amount_pence: row.released_amount_pence,
                                refunded_amount_pence: row.refunded_amount_pence,
                                provider_processing_fee_pence: row.provider_processing_fee_pence,
                                provider_state: row.provider_state,
                                session_status_display: row.session_status_display,
                                evidence_status: row.evidence_status,
                                allowed_actions: row.allowed_actions,
                              },
                              null,
                              2,
                            )}
                          </pre>
                          {inspectSnapshots[key] ? (
                            <pre className="whitespace-pre-wrap text-[11px]">
                              {JSON.stringify(inspectSnapshots[key], null, 2)}
                            </pre>
                          ) : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          Showing {pageStart}–{pageEnd} of {filteredTotal}
        </span>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={listOffset <= 0 || isFetching}
            onClick={onPagePrev}
          >
            Previous
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!hasMore || isFetching}
            onClick={onPageNext}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
