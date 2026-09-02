import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { DriverWalletSettlementHistoryRow } from '@/hooks/useDriverWalletSsot';
import { formatNullablePence } from '@/lib/formatNullablePence';
import { paymentSessionsUrl } from '../../../shared/adminPaymentSessionsSSOT';
import {
  buildDriverWalletCreditAuditFromSettlementRows,
  DRIVER_CREDIT_EXCEPTION_SCOPE,
  DRIVER_CREDIT_EXCEPTION_SCOPE_LABELS,
  DRIVER_CREDIT_RECOMMENDED_OWNER_LABELS,
  type DriverCreditExceptionScope,
  type DriverWalletCreditAuditRow,
} from '../../../shared/driverCreditMonitoringSSOT';
import { AlertTriangle, ClipboardList, Info } from 'lucide-react';

function scopeBadgeVariant(scope: DriverCreditExceptionScope): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (scope === DRIVER_CREDIT_EXCEPTION_SCOPE.ACTIVE_WALLET_IMPACTING) return 'destructive';
  if (scope === DRIVER_CREDIT_EXCEPTION_SCOPE.PENDING_SETTLEMENT) return 'secondary';
  return 'outline';
}

function mapSettlementRows(
  rows: DriverWalletSettlementHistoryRow[],
): Parameters<typeof buildDriverWalletCreditAuditFromSettlementRows>[0] {
  return rows.map((row) => ({
    trip_id: row.trip_id,
    trip_code: row.trip_code,
    driver_credit_health: row.driver_credit_health,
    expected_driver_credit_pence: row.expected_driver_credit_pence,
    actual_driver_credit_pence: row.actual_driver_credit_pence,
    credit_difference_pence: row.credit_difference_pence,
    credit_eligibility_at: row.credit_eligibility_at,
    settlement_status: row.settlement_status,
    completed_at: row.completed_at,
  }));
}

function AuditDrawerTable({
  rows,
  currencyCode,
  scopeFilter,
}: {
  rows: DriverWalletCreditAuditRow[];
  currencyCode: string;
  scopeFilter: DriverCreditExceptionScope | 'ALL';
}) {
  const filtered = scopeFilter === 'ALL'
    ? rows
    : rows.filter((row) => row.scope === scopeFilter);

  return (
    <div className="overflow-x-auto rounded-md border max-h-[55vh]">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Trip</TableHead>
            <TableHead>Classification</TableHead>
            <TableHead className="text-right">Expected</TableHead>
            <TableHead className="text-right">Credited</TableHead>
            <TableHead className="text-right">Variance</TableHead>
            <TableHead>Active impact</TableHead>
            <TableHead>Recommended owner</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filtered.length === 0 ? (
            <TableRow>
              <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                No audit rows in this scope.
              </TableCell>
            </TableRow>
          ) : (
            filtered.map((row) => (
              <TableRow key={`${row.trip_id ?? row.trip_code ?? row.driver_credit_health}-${row.classification_label}`}>
                <TableCell className="font-mono text-xs">
                  {row.trip_code ?? row.trip_id ?? '—'}
                </TableCell>
                <TableCell>
                  <div className="flex flex-col gap-1">
                    <Badge variant={scopeBadgeVariant(row.scope)} className="w-fit text-[10px]">
                      {DRIVER_CREDIT_EXCEPTION_SCOPE_LABELS[row.scope]}
                    </Badge>
                    <span className="text-[11px] text-muted-foreground">{row.driver_credit_health}</span>
                  </div>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatNullablePence(row.expected_driver_credit_pence, currencyCode)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatNullablePence(row.actual_driver_credit_pence, currencyCode)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatNullablePence(row.credit_difference_pence, currencyCode)}
                </TableCell>
                <TableCell>{row.active_wallet_impact ? 'Yes' : 'No'}</TableCell>
                <TableCell className="text-xs">
                  {DRIVER_CREDIT_RECOMMENDED_OWNER_LABELS[row.recommended_owner]}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}

/**
 * Read-only driver credit audit — calm chip + optional blocking alert for active items only.
 * Never suggests manual wallet adjustment as automatic repair.
 */
export function DriverWalletCreditAuditPanel({
  settlementRows,
  currencyCode = 'GBP',
}: {
  settlementRows: DriverWalletSettlementHistoryRow[];
  currencyCode?: string;
}) {
  const [open, setOpen] = useState(false);
  const [scopeFilter, setScopeFilter] = useState<DriverCreditExceptionScope | 'ALL'>('ALL');

  const audit = useMemo(
    () => buildDriverWalletCreditAuditFromSettlementRows(mapSettlementRows(settlementRows)),
    [settlementRows],
  );

  const { summary, rows } = audit;
  if (summary.total_audit_items <= 0) return null;

  const chipLabel = summary.active_wallet_impacting_count > 0
    ? `Credit audit: ${summary.active_wallet_impacting_count} active · review required`
    : summary.historical_backlog_count > 0
      ? `Credit audit: ${summary.historical_backlog_count} historical item${summary.historical_backlog_count === 1 ? '' : 's'}`
      : `Credit audit: ${summary.total_audit_items} item${summary.total_audit_items === 1 ? '' : 's'}`;

  const scopeCounts = [
    { scope: DRIVER_CREDIT_EXCEPTION_SCOPE.ACTIVE_WALLET_IMPACTING, count: summary.active_wallet_impacting_count },
    { scope: DRIVER_CREDIT_EXCEPTION_SCOPE.PENDING_SETTLEMENT, count: summary.pending_settlement_count },
    { scope: DRIVER_CREDIT_EXCEPTION_SCOPE.HISTORICAL_AUDIT_BACKLOG, count: summary.historical_backlog_count },
    { scope: DRIVER_CREDIT_EXCEPTION_SCOPE.RESOLVED_PAID_HISTORY, count: summary.resolved_paid_count },
  ].filter((entry) => entry.count > 0);

  return (
    <TooltipProvider>
      <div className="space-y-2">
        {summary.show_blocking_alert ? (
          <Alert variant="destructive" className="py-2">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle className="text-sm">Active wallet credit issue</AlertTitle>
            <AlertDescription className="text-xs space-y-1">
              <p>
                {summary.active_wallet_impacting_count} trip
                {summary.active_wallet_impacting_count === 1 ? '' : 's'} may affect current wallet balance or payout
                eligibility. Review the audit detail — do not use Add adjustment without evidence.
              </p>
              {summary.active_balance_variance_pence > 0 ? (
                <p className="text-muted-foreground">
                  Active variance under review: {formatNullablePence(summary.active_balance_variance_pence, currencyCode)}
                  {' '}(audit scope only — not a live balance adjustment).
                </p>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 text-xs font-normal"
                onClick={() => setOpen(true)}
              >
                <ClipboardList className="h-3.5 w-3.5" />
                {chipLabel}
              </Button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs text-xs">
              Read-only settlement audit. Historical mismatches do not change live wallet balances.
              Manual adjustment is for approved corrections only — not automatic repair.
            </TooltipContent>
          </Tooltip>
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <Info className="h-3 w-3" />
            Audit only — live balance cards above are authoritative
          </span>
        </div>

        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Driver credit audit</DialogTitle>
              <DialogDescription className="text-xs">
                Read-only comparison of expected trip entitlement vs wallet credits. Settlement repair is the default
                path for missing credits. Wallet adjustment requires separate approval and evidence — never implied
                as automatic repair.
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant={scopeFilter === 'ALL' ? 'secondary' : 'outline'}
                className="h-7 text-xs"
                onClick={() => setScopeFilter('ALL')}
              >
                All ({summary.total_audit_items})
              </Button>
              {scopeCounts.map(({ scope, count }) => (
                <Button
                  key={scope}
                  type="button"
                  size="sm"
                  variant={scopeFilter === scope ? 'secondary' : 'outline'}
                  className="h-7 text-xs"
                  onClick={() => setScopeFilter(scope)}
                >
                  {DRIVER_CREDIT_EXCEPTION_SCOPE_LABELS[scope]} ({count})
                </Button>
              ))}
            </div>

            <AuditDrawerTable rows={rows} currencyCode={currencyCode} scopeFilter={scopeFilter} />

            <p className="text-[11px] text-muted-foreground">
              For settlement repair, use{' '}
              <Link to="/financial-reconciliation" className="underline">Financial Reconciliation</Link>
              {' '}or{' '}
              <Link to={paymentSessionsUrl()} className="underline">Payment Sessions</Link>.
              {' '}Add adjustment is for approved goodwill/debt corrections only.
            </p>
          </DialogContent>
        </Dialog>
      </div>
    </TooltipProvider>
  );
}
