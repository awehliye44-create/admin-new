import { format } from 'date-fns';
import { Link } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import type { DriverWalletSsotRow } from '@/hooks/useDriverWalletSsot';
import { formatNullablePence } from '@/lib/formatNullablePence';
import { getTripDisplayId } from '@/lib/tripUtils';
import { paymentSessionsUrl } from '../../../shared/adminPaymentSessionsSSOT';
import { ProviderFeeConfigPanel } from '@/components/finance/ProviderFeeConfigPanel';

function Metric({
  label,
  value,
  hint,
  emphasize,
}: {
  label: string;
  value: string;
  hint?: string;
  emphasize?: boolean;
}) {
  return (
    <Card className={emphasize ? 'border-emerald-500/40' : undefined}>
      <CardContent className="pt-3 pb-3">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className={`font-semibold tabular-nums mt-0.5 ${emphasize ? 'text-xl' : 'text-lg'}`}>
          {value}
        </p>
        {hint ? <p className="text-[10px] text-muted-foreground mt-1">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return format(new Date(iso), 'dd MMM yyyy');
  } catch {
    return iso;
  }
}

function statusVariant(status: string | null | undefined): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'CONFIRMED') return 'default';
  if (status === 'ESTIMATED' || status === 'ADJUSTED') return 'secondary';
  if (status === 'NOT_APPLICABLE') return 'outline';
  return 'destructive';
}

/**
 * Commission tab — Gross ONECAB / Provider Fee / Net ONECAB.
 * Provider fees are never labeled as ONECAB commission credit.
 */
export function DriverWalletCommissionTab({
  driver,
  currencyCode = 'GBP',
  isLoading,
}: {
  driver: DriverWalletSsotRow | null | undefined;
  currencyCode?: string;
  isLoading?: boolean;
}) {
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading commission breakdown…
      </div>
    );
  }

  if (!driver) {
    return (
      <p className="text-sm text-muted-foreground py-8">
        Select a driver to view Gross ONECAB Commission, Provider Fees, and Net ONECAB Commission.
      </p>
    );
  }

  const fmt = (p: number | null | undefined) => formatNullablePence(p, currencyCode);
  const summary = driver.commission_fee_summary;
  const rows = driver.commission_fee_breakdown ?? [];
  const cfg = driver.active_provider_fee_config;

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Provider transaction fees are external costs paid to the payment provider — not ONECAB revenue.
        Net ONECAB Commission = Gross ONECAB Commission − Provider Fee.
      </p>

      <div className="grid gap-3 grid-cols-2 lg:grid-cols-5">
        <Metric
          label="Gross ONECAB Commission"
          value={fmt(summary?.gross_onecab_commission_pence)}
          hint="Platform commission before provider fees"
        />
        <Metric
          label="Payment Provider Fees"
          value={fmt(summary?.payment_provider_fees_pence)}
          hint="External acquiring cost — not ONECAB income"
        />
        <Metric
          label="Net ONECAB Commission After Provider Fees"
          value={fmt(summary?.net_onecab_commission_pence)}
          hint="Most prominent — ONECAB earnings after fees"
          emphasize
        />
        <Metric
          label="Transactions"
          value={summary?.transaction_count != null ? String(summary.transaction_count) : '—'}
          hint="Commissionable payment transactions"
        />
        <Card>
          <CardContent className="pt-3 pb-3 space-y-1">
            <p className="text-xs text-muted-foreground">Current Provider Fee Configuration</p>
            {cfg ? (
              <>
                <p className="text-sm font-medium">
                  Provider: {String(cfg.collection_provider ?? '—')}
                </p>
                <p className="text-xs text-muted-foreground">
                  Fee type: {String(cfg.fee_type ?? '—')}
                </p>
                <p className="text-xs tabular-nums">
                  Percentage:{' '}
                  {cfg.percentage_fee_bps != null
                    ? `${(Number(cfg.percentage_fee_bps) / 100).toFixed(2)}%`
                    : '—'}
                  {' · '}
                  Fixed: {fmt(cfg.fixed_fee_pence == null ? null : Number(cfg.fixed_fee_pence))}
                </p>
                <p className="text-xs text-muted-foreground">
                  Version: {String(cfg.version ?? '—')}
                  {' · '}
                  Effective from: {fmtDate(cfg.effective_from as string | null)}
                  {' · '}
                  {String(cfg.currency_code ?? currencyCode)}
                </p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">No active fee configuration for this service area.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Per-transaction commission</CardTitle>
          <p className="text-xs text-muted-foreground">
            Each row separates Gross ONECAB Commission, Provider Fee, and Net ONECAB Commission.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Trip ID</TableHead>
                  <TableHead>Payment Provider</TableHead>
                  <TableHead className="text-right">Commissionable Fare</TableHead>
                  <TableHead className="text-right">Commission Rate</TableHead>
                  <TableHead className="text-right">Gross ONECAB Commission</TableHead>
                  <TableHead className="text-right">Provider Percentage Fee</TableHead>
                  <TableHead className="text-right">Provider Fixed Fee</TableHead>
                  <TableHead className="text-right">Total Provider Fee</TableHead>
                  <TableHead className="text-right">Net ONECAB Commission</TableHead>
                  <TableHead>Fee Status</TableHead>
                  <TableHead>Provider Transaction ID</TableHead>
                  <TableHead>Fee Configuration Version</TableHead>
                  <TableHead className="text-right">Running Net ONECAB Balance</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={15} className="text-center text-muted-foreground py-8">
                      No commissionable settlements for this driver.
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((row) => (
                    <TableRow key={row.trip_id}>
                      <TableCell className="text-xs whitespace-nowrap">{fmtDate(row.completed_at)}</TableCell>
                      <TableCell className="text-xs font-mono">
                        {getTripDisplayId({ trip_code: row.trip_code, id: row.trip_id })}
                      </TableCell>
                      <TableCell className="text-xs">{row.payment_provider ?? '—'}</TableCell>
                      <TableCell className="text-xs text-right tabular-nums">
                        {fmt(row.commissionable_fare_pence)}
                      </TableCell>
                      <TableCell className="text-xs text-right tabular-nums">
                        {row.commission_rate_percent != null ? `${row.commission_rate_percent}%` : '—'}
                      </TableCell>
                      <TableCell className="text-xs text-right tabular-nums">
                        {fmt(row.gross_onecab_commission_pence)}
                      </TableCell>
                      <TableCell className="text-xs text-right tabular-nums text-muted-foreground">
                        {fmt(row.provider_percentage_fee_pence)}
                      </TableCell>
                      <TableCell className="text-xs text-right tabular-nums text-muted-foreground">
                        {fmt(row.provider_fixed_fee_pence)}
                      </TableCell>
                      <TableCell className="text-xs text-right tabular-nums text-amber-600">
                        {fmt(row.total_provider_fee_pence)}
                      </TableCell>
                      <TableCell className="text-xs text-right tabular-nums font-semibold text-emerald-600">
                        {fmt(row.net_onecab_commission_pence)}
                      </TableCell>
                      <TableCell>
                        <Badge variant={statusVariant(row.provider_fee_status)}>
                          {row.provider_fee_status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs font-mono max-w-[120px] truncate" title={row.provider_transaction_id ?? undefined}>
                        {row.provider_transaction_id ?? '—'}
                      </TableCell>
                      <TableCell className="text-xs font-mono">
                        {row.fee_configuration_version ?? '—'}
                      </TableCell>
                      <TableCell className="text-xs text-right tabular-nums font-medium">
                        {fmt(row.running_net_onecab_balance_pence)}
                      </TableCell>
                      <TableCell className="text-right">
                        {row.payment_session_id ? (
                          <Button variant="outline" size="sm" asChild>
                            <Link to={paymentSessionsUrl({ paymentSessionId: row.payment_session_id })}>
                              Open Payment Session
                            </Link>
                          </Button>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <ProviderFeeConfigPanel
        serviceAreaId={driver.service_area_id ?? null}
        currencyCode={currencyCode}
        activeConfig={cfg ?? null}
      />
    </div>
  );
}
