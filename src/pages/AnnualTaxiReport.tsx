import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { supabase } from '@/integrations/supabase/client';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Link, useSearchParams } from 'react-router-dom';
import { Info, Download, Printer, Mail, FileText, Loader2 } from 'lucide-react';
import { FinancialReconciliationTripLink } from '@/components/finance/FinancialReconciliationTripLink';
import { useToast } from '@/hooks/use-toast';
import { formatPence } from '@/hooks/useDriverWallet';
import { fetchDriverStatementPeriodTotals } from '@/hooks/financeReconciliationApi';
import { getTripDisplayId } from '@/lib/tripUtils';
import { downloadCsv, downloadExcel, printFinanceReport } from '@/lib/financeExport';
import { FinancePeriodFilter } from '@/components/finance/FinancePeriodFilter';
import {
  resolveFinancePeriodBounds,
  type FinancePeriod,
} from '@/lib/financePeriodFilter';

type PeriodMode = FinancePeriod | 'tax_year' | 'calendar_year';

interface DriverRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  driver_code: string | null;
  region_id: string | null;
}
interface RegionRow { id: string; name: string }

interface TripRow {
  id: string;
  trip_code: string | null;
  trip_number: string | null;
  driver_id: string;
  completed_at: string | null;
  payment_method: string | null;
  status: string | null;
  currency_code: string | null;
  gross_fare_pence: number | null;
  final_fare_pence: number | null;
  final_customer_fare_pence: number | null;
  commission_pence: number | null;
  driver_net_pence: number | null;
  driver_total_earnings_pence: number | null;
  tip_amount_pence: number | null;
  tip_pence: number | null;
  corporate_account_id: string | null;
  region_id: string | null;
}

function ukTaxYearRange(startYear: number) {
  return {
    start: `${startYear}-04-06`,
    end: `${startYear + 1}-04-05`,
  };
}

function calendarYearRange(year: number) {
  return { start: `${year}-01-01`, end: `${year}-12-31` };
}

function driverName(d: DriverRow | undefined): string {
  if (!d) return 'Unknown';
  return [d.first_name, d.last_name].filter(Boolean).join(' ') || d.driver_code || d.id;
}

function tripTip(t: TripRow): number {
  return t.tip_amount_pence ?? t.tip_pence ?? 0;
}

export default function AnnualTaxiReport() {
  const { toast } = useToast();
  const currentYear = new Date().getFullYear();
  const [searchParams] = useSearchParams();

  const [driverId, setDriverId] = useState<string>(() => searchParams.get('driverId') ?? '');
  const [regionId, setRegionId] = useState<string>('__all__');
  const [periodMode, setPeriodMode] = useState<PeriodMode>('month');
  const [taxYearStart, setTaxYearStart] = useState<string>(String(currentYear - 1));
  const [calendarYear, setCalendarYear] = useState<string>(String(currentYear - 1));
  const [customFrom, setCustomFrom] = useState<string>('');
  const [customTo, setCustomTo] = useState<string>('');
  const [customDateFrom, setCustomDateFrom] = useState<Date | undefined>(undefined);
  const [customDateTo, setCustomDateTo] = useState<Date | undefined>(undefined);
  const [generated, setGenerated] = useState<{ driverId: string; from: string; to: string } | null>(null);

  useEffect(() => {
    const fromUrl = searchParams.get('driverId');
    if (fromUrl) setDriverId(fromUrl);
  }, [searchParams]);

  const { data: regions = [] } = useQuery({
    queryKey: ['atr-regions'],
    queryFn: async () => {
      const { data, error } = await supabase.from('regions').select('id,name').order('name');
      if (error) throw error;
      return (data ?? []) as RegionRow[];
    },
  });

  const { data: drivers = [] } = useQuery({
    queryKey: ['atr-drivers', regionId],
    queryFn: async () => {
      let q = supabase.from('drivers').select('id,first_name,last_name,driver_code,region_id').order('driver_code', { ascending: true }).limit(1000);
      if (regionId !== '__all__') q = q.eq('region_id', regionId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as DriverRow[];
    },
  });

  const dateRange = useMemo(() => {
    if (periodMode === 'tax_year') return ukTaxYearRange(Number(taxYearStart));
    if (periodMode === 'calendar_year') return calendarYearRange(Number(calendarYear));
    if (periodMode === 'custom' && customFrom && customTo) {
      return { start: customFrom, end: customTo };
    }
    const bounds = resolveFinancePeriodBounds(
      periodMode === 'custom' ? 'custom' : periodMode,
      customDateFrom,
      customDateTo,
    );
    return {
      start: format(new Date(bounds.from), 'yyyy-MM-dd'),
      end: format(new Date(bounds.to), 'yyyy-MM-dd'),
    };
  }, [periodMode, taxYearStart, calendarYear, customFrom, customTo, customDateFrom, customDateTo]);

  const canGenerate = !!driverId && !!dateRange.start && !!dateRange.end;

  const reportQuery = useQuery({
    enabled: !!generated,
    queryKey: ['atr-report', generated],
    queryFn: async () => {
      if (!generated) return null;
      const startIso = new Date(`${generated.from}T00:00:00Z`).toISOString();
      const endIso = new Date(`${generated.to}T23:59:59Z`).toISOString();

      const { data: tripsData, error: tripsErr } = await supabase
        .from('trips')
        .select('id,trip_code,trip_number,driver_id,completed_at,payment_method,status,currency_code,gross_fare_pence,final_fare_pence,final_customer_fare_pence,commission_pence,driver_net_pence,driver_total_earnings_pence,tip_amount_pence,tip_pence,corporate_account_id,region_id')
        .eq('driver_id', generated.driverId)
        .eq('status', 'completed')
        .gte('completed_at', startIso)
        .lte('completed_at', endIso)
        .order('completed_at', { ascending: true })
        .limit(5000);
      if (tripsErr) throw tripsErr;

      return {
        trips: (tripsData ?? []) as TripRow[],
      };
    },
  });

  const statementTotalsQuery = useQuery({
    enabled: !!generated,
    queryKey: ['atr-statement-totals', generated],
    queryFn: async () => {
      if (!generated) return null;
      const { data: driverRow, error: driverErr } = await supabase
        .from('drivers')
        .select('region_id')
        .eq('id', generated.driverId)
        .maybeSingle();
      if (driverErr) throw driverErr;
      if (!driverRow?.region_id) return null;
      const totals = await fetchDriverStatementPeriodTotals(
        { regionId: driverRow.region_id, serviceAreaId: null, currencyCode: null },
        `${generated.from}T00:00:00.000Z`,
        `${generated.to}T23:59:59.999Z`,
        [generated.driverId],
      );
      return totals[0] ?? null;
    },
  });

  const driver = useMemo(() => drivers.find((d) => d.id === (generated?.driverId ?? driverId)), [drivers, driverId, generated]);

  const summary = useMemo(() => {
    const trips = reportQuery.data?.trips ?? [];
    let tips = 0;
    let cash = 0, card = 0, corporate = 0;
    for (const t of trips) {
      tips += tripTip(t);
      const pm = String(t.payment_method ?? '').toUpperCase();
      if (t.corporate_account_id) corporate += 1;
      else if (pm === 'CASH') cash += 1;
      else if (pm === 'CARD' || pm === 'APPLE_PAY' || pm === 'GOOGLE_PAY' || pm === 'WALLET') card += 1;
    }
    const st = statementTotalsQuery.data;
    const currency = trips.find((t) => t.currency_code)?.currency_code ?? 'GBP';
    return {
      totalTrips: trips.length,
      tips,
      cash, card, corporate,
      currency,
      grossEarnings: st?.gross_earnings_pence ?? null,
      commission: st?.commission_pence ?? null,
      driverNet: st?.driver_net_pence ?? null,
      bonuses: st?.bonuses_pence ?? null,
      adjustments: st?.adjustments_pence ?? null,
      debtRecovery: st?.debt_recovery_pence ?? null,
      penalties: st?.penalties_pence ?? null,
      netEarnings: st?.net_earnings_pence ?? null,
      payoutsTotal: st?.payouts_received_pence ?? null,
      completedTrips: st?.completed_trips ?? null,
    };
  }, [reportQuery.data, statementTotalsQuery.data]);

  const handleGenerate = () => {
    if (!canGenerate) {
      toast({ title: 'Missing filters', description: 'Pick a driver and a valid date range.', variant: 'destructive' });
      return;
    }
    setGenerated({ driverId, from: dateRange.start, to: dateRange.end });
  };

  const periodLabel = useMemo(() => {
    if (!generated) return '';
    return `${format(new Date(generated.from), 'd MMM yyyy')} – ${format(new Date(generated.to), 'd MMM yyyy')}`;
  }, [generated]);

  const handleCsv = () => {
    if (!reportQuery.data || !generated) return;
    const money = (p: number | null) => (p == null ? '' : (p / 100).toFixed(2));
    downloadCsv(
      `annual-taxi-report-summary-${driver?.driver_code ?? driver?.id ?? 'driver'}-${generated.from}-${generated.to}.csv`,
      [
        {
          gross_earnings: money(summary.grossEarnings),
          commission: money(summary.commission),
          driver_net: money(summary.driverNet),
          bonuses: money(summary.bonuses),
          adjustments: money(summary.adjustments),
          debt_recovery: money(summary.debtRecovery),
          penalties: money(summary.penalties),
          net_earnings: money(summary.netEarnings),
          payouts_received: money(summary.payoutsTotal),
          tips: money(summary.tips),
          total_trips: summary.totalTrips,
        },
      ],
    );
  };

  const handleExcel = () => {
    if (!reportQuery.data || !generated) return;
    const fmt = (p: number | null) => (p == null ? '—' : (p / 100).toFixed(2));
    downloadExcel(
      `annual-taxi-report-${driver?.driver_code ?? driver?.id ?? 'driver'}-${generated.from}-${generated.to}`,
      [
        {
          name: 'Summary',
          rows: [
            ['Line', 'Amount'],
            ['Gross earnings', fmt(summary.grossEarnings)],
            ['ONECAB commission', fmt(summary.commission)],
            ['Driver net', fmt(summary.driverNet)],
            ['Bonuses', fmt(summary.bonuses)],
            ['Adjustments', fmt(summary.adjustments)],
            ['Debt recovery', fmt(summary.debtRecovery)],
            ['Penalties', fmt(summary.penalties)],
            ['Net earnings', fmt(summary.netEarnings)],
            ['Payouts received', fmt(summary.payoutsTotal)],
            ['Tips', fmt(summary.tips)],
            ['Total trips', summary.totalTrips],
          ],
        },
        {
          name: 'Trips',
          rows: [
            ['Date', 'Trip ID', 'Payment Type', 'Status'],
            ...reportQuery.data.trips.map((t) => [
              t.completed_at ? format(new Date(t.completed_at), 'yyyy-MM-dd HH:mm') : '',
              getTripDisplayId(t as any) || t.id,
              t.corporate_account_id ? 'CORPORATE' : (t.payment_method ?? ''),
              t.status ?? '',
            ]),
          ],
        },
      ],
    );
  };

  const handlePrint = () => printFinanceReport();

  const handleEmail = () => {
    if (!generated || !driver) return;
    const subject = encodeURIComponent(`Annual Taxi Report — ${driverName(driver)} — ${periodLabel}`);
    const money = (p: number | null) => (p == null ? '—' : formatPence(p, summary.currency));
    const body = encodeURIComponent(
      `Annual Taxi Report\n\nDriver: ${driverName(driver)} (${driver.driver_code ?? driver.id})\nPeriod: ${periodLabel}\n\n` +
      `Gross earnings: ${money(summary.grossEarnings)}\nCommission: ${money(summary.commission)}\nDriver net: ${money(summary.driverNet)}\n` +
      `Bonuses: ${money(summary.bonuses)}\nAdjustments: ${money(summary.adjustments)}\nDebt recovery: ${money(summary.debtRecovery)}\n` +
      `Payouts received: ${money(summary.payoutsTotal)}\nTips: ${money(summary.tips)}\nTotal trips: ${summary.totalTrips}\n\n` +
      `Values from Driver Statement / Wallet SSOT. This report is for record keeping only.`,
    );
    window.location.href = `mailto:?subject=${subject}&body=${body}`;
  };

  return (
    <AdminLayout
      title="Annual Taxi Report"
      description="Read-only earnings report for self-employed drivers. Not used for payouts, wallet, or reconciliation."
    >
      <div className="space-y-6">
        <Alert>
          <Info className="h-4 w-4" />
          <AlertTitle>Reporting only</AlertTitle>
          <AlertDescription>
            Financial Reconciliation audits Provider integrity. Trip settlement values are on Trip History only.
            and Provider reconciliation. This page never calculates or modifies financial values.
          </AlertDescription>
        </Alert>

        <Card className="print:hidden">
          <CardHeader>
            <CardTitle>Filters</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>Region</Label>
                <Select value={regionId} onValueChange={setRegionId}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__all__">All Regions</SelectItem>
                    {regions.map((r) => (
                      <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2 md:col-span-2">
                <Label>Driver</Label>
                <Select value={driverId} onValueChange={setDriverId}>
                  <SelectTrigger><SelectValue placeholder="Select a driver…" /></SelectTrigger>
                  <SelectContent className="max-h-72">
                    {drivers.map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.driver_code ? `${d.driver_code} — ` : ''}{driverName(d)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-3">
              <Label>Period</Label>
              <FinancePeriodFilter
                period={
                  periodMode === 'tax_year' || periodMode === 'calendar_year'
                    ? 'custom'
                    : periodMode
                }
                onPeriodChange={(p) => {
                  setPeriodMode(p);
                  if (p !== 'custom') {
                    setCustomFrom('');
                    setCustomTo('');
                  }
                }}
                customFrom={customDateFrom}
                customTo={customDateTo}
                onCustomFromChange={(d) => {
                  setCustomDateFrom(d);
                  setCustomFrom(d ? format(d, 'yyyy-MM-dd') : '');
                }}
                onCustomToChange={(d) => {
                  setCustomDateTo(d);
                  setCustomTo(d ? format(d, 'yyyy-MM-dd') : '');
                }}
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={periodMode === 'tax_year' ? 'default' : 'outline'}
                  onClick={() => setPeriodMode('tax_year')}
                >
                  UK Tax Year
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={periodMode === 'calendar_year' ? 'default' : 'outline'}
                  onClick={() => setPeriodMode('calendar_year')}
                >
                  Calendar Year
                </Button>
              </div>
              {periodMode === 'tax_year' && (
                <div className="space-y-2 max-w-xs">
                  <Label>Tax Year Start</Label>
                  <Select value={taxYearStart} onValueChange={setTaxYearStart}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {Array.from({ length: 8 }).map((_, i) => {
                        const y = currentYear - i;
                        return <SelectItem key={y} value={String(y)}>{y}/{(y + 1).toString().slice(2)}</SelectItem>;
                      })}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {periodMode === 'calendar_year' && (
                <div className="space-y-2 max-w-xs">
                  <Label>Year</Label>
                  <Select value={calendarYear} onValueChange={setCalendarYear}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {Array.from({ length: 8 }).map((_, i) => {
                        const y = currentYear - i;
                        return <SelectItem key={y} value={String(y)}>{y}</SelectItem>;
                      })}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>

            <div className="flex flex-wrap gap-2 pt-2">
              <Button onClick={handleGenerate} disabled={!canGenerate}>
                <FileText className="h-4 w-4" />
                Generate Report
              </Button>
              {generated && (
                <>
                  <Button variant="outline" onClick={handleCsv} disabled={!reportQuery.data}>
                    <Download className="h-4 w-4" />Export CSV
                  </Button>
                  <Button variant="outline" onClick={handleExcel} disabled={!reportQuery.data}>
                    <Download className="h-4 w-4" />Export Excel
                  </Button>
                  <Button variant="outline" onClick={handlePrint} disabled={!reportQuery.data}>
                    <Printer className="h-4 w-4" />Print / PDF
                  </Button>
                  <Button variant="outline" onClick={handleEmail} disabled={!reportQuery.data}>
                    <Mail className="h-4 w-4" />Email Report
                  </Button>
                </>
              )}
            </div>
          </CardContent>
        </Card>

        {reportQuery.isFetching && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading report…
          </div>
        )}

        {generated && reportQuery.data && (
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <CardTitle>Report Summary</CardTitle>
                    <p className="text-sm text-muted-foreground mt-1">
                      {driverName(driver)} · {driver?.driver_code ?? '—'} · {periodLabel}
                    </p>
                  </div>
                  <Badge variant="outline">Read-only</Badge>
                </div>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <SummaryStat label="Total Trips" value={String(summary.totalTrips)} />
                  <SummaryStat label="Cash Trips" value={String(summary.cash)} />
                  <SummaryStat label="Card Trips" value={String(summary.card)} />
                  <SummaryStat label="Corporate Trips" value={String(summary.corporate)} />
                  <SummaryStat label="Gross earnings" value={summary.grossEarnings == null ? '—' : formatPence(summary.grossEarnings, summary.currency)} />
                  <SummaryStat label="ONECAB commission" value={summary.commission == null ? '—' : formatPence(summary.commission, summary.currency)} />
                  <SummaryStat label="Driver net" value={summary.driverNet == null ? '—' : formatPence(summary.driverNet, summary.currency)} />
                  <SummaryStat label="Bonuses" value={summary.bonuses == null ? '—' : formatPence(summary.bonuses, summary.currency)} />
                  <SummaryStat label="Adjustments" value={summary.adjustments == null ? '—' : formatPence(summary.adjustments, summary.currency)} />
                  <SummaryStat label="Debt recovery" value={summary.debtRecovery == null ? '—' : formatPence(summary.debtRecovery, summary.currency)} />
                  <SummaryStat label="Tips" value={formatPence(summary.tips, summary.currency)} />
                  <SummaryStat label="Payouts Received" value={summary.payoutsTotal == null ? '—' : formatPence(summary.payoutsTotal, summary.currency)} />
                </div>
                <p className="text-xs text-muted-foreground mt-4">
                  Rollups from Driver Statement SSOT (Wallet ledger + FR audit). Linked from{' '}
                  <Link to="/driver-wallet-ledger" className="underline">Driver Wallet</Link>
                  {' · '}
                  <Link to="/payout-ledger" className="underline">Payout Ledger</Link>
                  .
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Detailed Breakdown</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Trip ID</TableHead>
                      <TableHead>Payment Type</TableHead>
                      <TableHead>Financial Reconciliation</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {reportQuery.data.trips.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                          No completed trips in this period.
                        </TableCell>
                      </TableRow>
                    )}
                    {reportQuery.data.trips.map((t) => (
                      <TableRow key={t.id}>
                        <TableCell className="whitespace-nowrap">
                          {t.completed_at ? format(new Date(t.completed_at), 'dd MMM yyyy HH:mm') : '—'}
                        </TableCell>
                        <TableCell className="font-mono text-xs">{getTripDisplayId(t as any) || t.id.slice(0, 8)}</TableCell>
                        <TableCell>{t.corporate_account_id ? 'CORPORATE' : (t.payment_method ?? '—')}</TableCell>
                        <TableCell>
                          <FinancialReconciliationTripLink
                            tripId={t.id}
                            tripCode={t.trip_code}
                            tripNumber={t.trip_number}
                          />
                        </TableCell>
                        <TableCell><Badge variant="outline">{t.status ?? '—'}</Badge></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            <Alert>
              <Info className="h-4 w-4" />
              <AlertTitle>Disclaimer</AlertTitle>
              <AlertDescription>
                This report is provided for record keeping purposes only. Drivers are self-employed and responsible
                for their own tax, National Insurance, expenses, and HMRC obligations.
              </AlertDescription>
            </Alert>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}

function SummaryStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold mt-1">{value}</p>
    </div>
  );
}
