import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Loader2, RefreshCw, ShieldAlert } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatPence } from '@/hooks/useDriverWallet';
import {
  useAdminHoldAction,
  usePaymentHoldsReconciliation,
} from '@/hooks/usePaymentHoldsReconciliation';
import type {
  PaymentHoldClassification,
  PaymentHoldReconciliationRow,
} from '../../shared/paymentHoldReconciliation';
import { financeReconciliationTripUrl } from '@/lib/financialReconciliationRoutes';
import { toast } from 'sonner';

const HOLD_CLASS_LABEL: Record<PaymentHoldReconciliationRow['hold_classification'], string> = {
  OK_ACTIVE_TRIP: 'Active trip — hold expected',
  OK_COMPLETED_CAPTURED: 'Captured — OK',
  OK_CANCELLED_RELEASED: 'Released — OK',
  BLOCKED_HOLD_NO_TRIP: 'Authorised hold with no trip',
  BLOCKED_CANCELLED_NOT_RELEASED: 'Cancelled trip — hold not released',
  BLOCKED_EXPIRED_NOT_RELEASED: 'Expired trip — hold not released',
  BLOCKED_RELEASE_FAILED: 'Release failed',
  BLOCKED_UNKNOWN_STATE: 'Unknown hold state',
};

function classificationVariant(
  classification: PaymentHoldClassification,
): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (classification === 'GREEN') return 'default';
  if (classification === 'AMBER') return 'secondary';
  return 'destructive';
}

function formatAge(minutes: number): string {
  if (minutes < 1) return '<1 min';
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  const rem = Math.round(minutes % 60);
  return rem > 0 ? `${hours}h ${rem}m` : `${hours}h`;
}

function formatAmount(row: PaymentHoldReconciliationRow): string {
  if (row.amount_display === 'AMOUNT_UNCONFIRMED') {
    return 'AMOUNT_UNCONFIRMED';
  }
  if (row.released_at && (row.released_amount_pence == null)) {
    return `${formatPence(row.amount_pence, row.currency)} (release AMOUNT_UNCONFIRMED)`;
  }
  return formatPence(row.amount_pence, row.currency);
}

type PaymentHoldsAttentionPanelProps = {
  readOnly?: boolean;
};

type PanelView = 'attention' | 'history';

export function PaymentHoldsAttentionPanel({ readOnly = false }: PaymentHoldsAttentionPanelProps) {
  const [view, setView] = useState<PanelView>('attention');
  const { data, isLoading, isFetching, error, refetch } = usePaymentHoldsReconciliation(true);
  const holdAction = useAdminHoldAction();
  const [actingId, setActingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const attentionRows = useMemo(
    () => (data?.payment_holds_requiring_attention ?? []).filter(
      (r) => r.in_active_queue !== false && r.classification !== 'GREEN',
    ),
    [data?.payment_holds_requiring_attention],
  );

  const historyRows = useMemo(
    () => data?.payment_holds_history ?? [],
    [data?.payment_holds_history],
  );

  const displayRows = view === 'history' ? historyRows : attentionRows;
  const summary = data?.summary;

  const runAction = useCallback(
    async (
      row: PaymentHoldReconciliationRow,
      action: 'release' | 'retry_release' | 'retry_recovery',
    ) => {
      if (readOnly) {
        toast.error('Hold actions disabled while Financial Reconciliation is read-only.');
        return;
      }
      const actionKey = row.provider_order_id || row.payment_session_id;
      setActingId(actionKey);
      try {
        const result = await holdAction.mutateAsync({
          ...(row.source === 'payment_sessions' ? { payment_session_id: row.payment_session_id } : {}),
          provider_order_id: row.provider_order_id,
          action,
        }) as { already_resolved?: boolean };
        if (result?.already_resolved) {
          toast.success('Hold already resolved at provider');
        } else {
          toast.success(`Hold ${action.replace('_', ' ')} requested`);
        }
        await refetch();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Hold action failed');
      } finally {
        setActingId(null);
      }
    },
    [holdAction, readOnly, refetch],
  );

  const copyPaymentSessionRef = useCallback((row: PaymentHoldReconciliationRow) => {
    const text = [
      `payment_session_id: ${row.payment_session_id}`,
      `provider_order_id: ${row.provider_order_id}`,
      `source: ${row.source}`,
      row.orphan_evidence_id ? `orphan_evidence_id: ${row.orphan_evidence_id}` : null,
      row.resolution_source ? `resolution_source: ${row.resolution_source}` : null,
      row.hold_terminal_reason ? `hold_terminal_reason: ${row.hold_terminal_reason}` : null,
    ].filter(Boolean).join('\n');
    void navigator.clipboard.writeText(text);
    toast.success('Payment session references copied');
  }, []);

  if (isLoading && !data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <ShieldAlert className="h-4 w-4" />
            Payment holds requiring attention
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">Loading payment holds…</CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>Payment holds unavailable</AlertTitle>
        <AlertDescription className="space-y-2">
          <p>{error instanceof Error ? error.message : 'Failed to load payment holds'}</p>
          <Button variant="outline" size="sm" onClick={() => void refetch()}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <ShieldAlert className="h-4 w-4" />
              Payment holds
            </CardTitle>
            <CardDescription className="mt-1">
              Revolut pre-authorisation holds — release SSOT. Attention queue is active only;
              history keeps resolved evidence searchable.
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-md border overflow-hidden">
              <Button
                variant={view === 'attention' ? 'default' : 'ghost'}
                size="sm"
                className="rounded-none"
                onClick={() => setView('attention')}
              >
                Attention
              </Button>
              <Button
                variant={view === 'history' ? 'default' : 'ghost'}
                size="sm"
                className="rounded-none"
                onClick={() => setView('history')}
              >
                History
                {typeof summary?.resolved_count === 'number' ? ` (${summary.resolved_count})` : ''}
              </Button>
            </div>
            {summary && view === 'attention' && (
              <>
                <Badge variant="destructive">{summary.red} RED</Badge>
                <Badge variant="secondary">{summary.amber} AMBER</Badge>
                <Badge variant="outline">{summary.green} GREEN</Badge>
                {(summary.active_hold_amount_pence ?? summary.total_hold_pence) > 0 && (
                  <Badge variant="outline">
                    {formatPence(
                      summary.active_hold_amount_pence ?? summary.total_hold_pence,
                      attentionRows[0]?.currency ?? 'GBP',
                    )}{' '}
                    at risk
                    {typeof summary.active_hold_count === 'number'
                      ? ` (${summary.active_hold_count})`
                      : ''}
                  </Badge>
                )}
              </>
            )}
            <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isFetching}>
              <RefreshCw className={`h-4 w-4 mr-2 ${isFetching ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {displayRows.length === 0 ? (
          <Alert>
            <AlertTitle>
              {view === 'history'
                ? 'No resolved hold history in this window'
                : 'No payment holds requiring attention'}
            </AlertTitle>
            <AlertDescription>
              {view === 'history'
                ? 'Resolved, cancelled, reverted and companion evidence will appear here after Refresh.'
                : (
                  <>
                    All monitored Revolut holds are GREEN for the current provider state.
                    {summary && summary.total > 0 ? ` (${summary.total} holds checked.)` : null}
                  </>
                )}
            </AlertDescription>
          </Alert>
        ) : (
          <div className="rounded-md border overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Status</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Provider order</TableHead>
                  <TableHead>Trip</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>{view === 'history' ? 'Resolved' : 'Age'}</TableHead>
                  <TableHead>Reason / evidence</TableHead>
                  {view === 'attention' && <TableHead className="text-right">Actions</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {displayRows.map((row) => {
                  const actionKey = row.provider_order_id || row.payment_session_id;
                  const busy = actingId === actionKey && holdAction.isPending;
                  const expanded = expandedId === row.id;
                  return (
                    <TableRow key={row.id}>
                      <TableCell>
                        <Badge variant={classificationVariant(row.classification)}>
                          {row.attention_class ?? row.classification}
                        </Badge>
                        {row.source === 'orphan_payments' && (
                          <div className="text-[10px] text-muted-foreground mt-1">orphan</div>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="text-sm font-medium">{row.customer_name ?? '—'}</div>
                        <div className="text-xs text-muted-foreground truncate max-w-[180px]">
                          {row.customer_email ?? row.customer_id?.slice(0, 8) ?? '—'}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="text-xs font-mono truncate max-w-[140px]" title={row.provider_order_id}>
                          {row.provider_order_id.slice(0, 8)}…
                        </div>
                        <Button
                          variant="link"
                          className="h-auto p-0 text-xs"
                          onClick={() => copyPaymentSessionRef(row)}
                        >
                          Copy refs
                        </Button>
                        <Button
                          variant="link"
                          className="h-auto p-0 text-xs ml-2"
                          onClick={() => setExpandedId(expanded ? null : row.id)}
                        >
                          {expanded ? 'Hide' : 'Evidence'}
                        </Button>
                        {expanded && (
                          <div className="mt-2 text-[10px] text-muted-foreground space-y-0.5 max-w-[200px]">
                            <div>session: {row.payment_session_id.slice(0, 8)}…</div>
                            {row.orphan_evidence_id && (
                              <div>orphan: {row.orphan_evidence_id.slice(0, 8)}…</div>
                            )}
                            {row.provider_order_state && (
                              <div>provider: {row.provider_order_state}</div>
                            )}
                            {row.resolution_source && (
                              <div>source: {row.resolution_source}</div>
                            )}
                            {row.provider_state_verified_at && (
                              <div>verified: {row.provider_state_verified_at}</div>
                            )}
                            {row.release_failure_reason && (
                              <div>failure: {row.release_failure_reason}</div>
                            )}
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        {row.trip_id ? (
                          <div className="space-y-1">
                            <div className="text-sm">{row.trip_code ?? row.trip_id.slice(0, 8)}</div>
                            <div className="text-xs text-muted-foreground">{row.trip_status ?? '—'}</div>
                            {row.can_open_trip && (
                              <Button asChild variant="link" className="h-auto p-0 text-xs">
                                <Link to={financeReconciliationTripUrl(row.trip_id, row.trip_code)}>
                                  Open trip
                                </Link>
                              </Button>
                            )}
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">No trip</span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">{formatAmount(row)}</TableCell>
                      <TableCell className="text-xs">
                        {view === 'history'
                          ? (row.released_at ?? row.provider_state_verified_at ?? '—')
                          : formatAge(row.age_minutes)}
                      </TableCell>
                      <TableCell>
                        <div className="text-xs max-w-[220px]">
                          {row.attention_class
                            ? String(row.attention_class).replace(/_/g, ' ')
                            : HOLD_CLASS_LABEL[row.hold_classification]}
                          {row.hold_terminal_reason && (
                            <div className="text-muted-foreground mt-1">{row.hold_terminal_reason}</div>
                          )}
                          {row.release_failure_reason && (
                            <div className="text-destructive mt-1">{row.release_failure_reason}</div>
                          )}
                          {row.provider_order_state && (
                            <div className="text-muted-foreground mt-1">
                              Provider: {row.provider_order_state}
                            </div>
                          )}
                        </div>
                      </TableCell>
                      {view === 'attention' && (
                        <TableCell className="text-right">
                          <div className="flex flex-wrap justify-end gap-1">
                            {row.can_release && (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={readOnly || busy}
                                onClick={() => void runAction(row, 'release')}
                              >
                                {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Release'}
                              </Button>
                            )}
                            {row.can_retry_release && (
                              <Button
                                size="sm"
                                variant="secondary"
                                disabled={readOnly || busy}
                                onClick={() => void runAction(row, 'retry_release')}
                              >
                                Retry release
                              </Button>
                            )}
                            {row.can_retry_recovery && (
                              <Button
                                size="sm"
                                variant="secondary"
                                disabled={readOnly || busy}
                                onClick={() => void runAction(row, 'retry_recovery')}
                              >
                                Retry recovery
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
