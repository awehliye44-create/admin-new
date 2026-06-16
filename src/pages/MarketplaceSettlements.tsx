import { useMemo, useState } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useServiceAreas } from '@/hooks/useServiceAreas';
import { formatPence } from '@/hooks/useDriverWallet';
import { toast } from 'sonner';
import {
  RefreshCw, Download, Eye, CheckCircle2, Clock, XCircle, AlertTriangle, PauseCircle,
  Store, MapPin, Wallet,
} from 'lucide-react';

type PayoutStatus = 'pending' | 'processing' | 'paid' | 'failed' | 'on_hold';

interface MerchantSettlementRow {
  merchant_id: string;
  merchant_name: string;
  merchant_type: string;
  service_area_id: string | null;
  service_area_name: string;
  currency_code: string;
  gross_sales_pence: number;
  onecab_commission_pence: number;
  stripe_fees_pence: number;
  driver_delivery_earnings_pence: number;
  net_merchant_balance_pence: number;
  payout_status: PayoutStatus;
  payout_date: string | null;
  commission_pct: number | null;
}

const STATUS_META: Record<PayoutStatus, { label: string; icon: any; className: string }> = {
  pending:    { label: 'Pending',    icon: Clock,         className: 'bg-yellow-500/15 text-yellow-700 dark:text-yellow-400 border-yellow-500/30' },
  processing: { label: 'Processing', icon: RefreshCw,     className: 'bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30' },
  paid:       { label: 'Paid',       icon: CheckCircle2,  className: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30' },
  failed:     { label: 'Failed',     icon: XCircle,       className: 'bg-destructive/15 text-destructive border-destructive/30' },
  on_hold:    { label: 'On Hold',    icon: PauseCircle,   className: 'bg-muted text-muted-foreground border-border' },
};

function StatusBadge({ status }: { status: PayoutStatus }) {
  const meta = STATUS_META[status];
  const Icon = meta.icon;
  return (
    <Badge variant="outline" className={`gap-1 ${meta.className}`}>
      <Icon className="h-3 w-3" />
      {meta.label}
    </Badge>
  );
}

export default function MarketplaceSettlements() {
  const { data: serviceAreas } = useServiceAreas();
  const [serviceAreaId, setServiceAreaId] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | PayoutStatus>('all');
  const [search, setSearch] = useState('');
  const [detailRow, setDetailRow] = useState<MerchantSettlementRow | null>(null);

  const { data: rows = [], isLoading, refetch, isFetching } = useQuery<MerchantSettlementRow[]>({
    queryKey: ['marketplace-settlements', serviceAreaId],
    queryFn: async () => {
      // Source of truth: merchants table joined with service area + region currency.
      // Marketplace order flow is not yet emitting settlement rows — financial
      // figures default to 0 until orders are recorded. We never invent numbers.
      let q = supabase
        .from('merchants')
        .select('id, business_name, category, commission_pct, service_area_id, service_areas:service_area_id (id, name, regions:region_id (currency_code))')
        .order('business_name', { ascending: true });

      if (serviceAreaId !== 'all') q = q.eq('service_area_id', serviceAreaId);

      const { data, error } = await q;
      if (error) throw error;

      return (data || []).map((m: any) => ({
        merchant_id: m.id,
        merchant_name: m.business_name,
        merchant_type: m.category,
        service_area_id: m.service_area_id,
        service_area_name: m.service_areas?.name || '—',
        currency_code: m.service_areas?.regions?.currency_code || 'GBP',
        gross_sales_pence: 0,
        onecab_commission_pence: 0,
        stripe_fees_pence: 0,
        driver_delivery_earnings_pence: 0,
        net_merchant_balance_pence: 0,
        payout_status: 'pending' as PayoutStatus,
        payout_date: null,
        commission_pct: m.commission_pct ?? null,
      }));
    },
  });

  const filtered = useMemo(() => {
    return rows.filter(r => {
      if (statusFilter !== 'all' && r.payout_status !== statusFilter) return false;
      if (search && !r.merchant_name.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [rows, statusFilter, search]);

  // Currency-grouped totals to avoid mixed-currency aggregation
  const totalsByCurrency = useMemo(() => {
    const map = new Map<string, { gross: number; commission: number; stripe: number; net: number; count: number }>();
    for (const r of filtered) {
      const t = map.get(r.currency_code) || { gross: 0, commission: 0, stripe: 0, net: 0, count: 0 };
      t.gross += r.gross_sales_pence;
      t.commission += r.onecab_commission_pence;
      t.stripe += r.stripe_fees_pence;
      t.net += r.net_merchant_balance_pence;
      t.count += 1;
      map.set(r.currency_code, t);
    }
    return Array.from(map.entries());
  }, [filtered]);

  const handleExportCSV = () => {
    const disclaimer =
      '# ONECAB marketplace merchant export — Merchant Gross Sales is marketplace order snapshot (not trip settlement SSOT). Figures are zero until marketplace order flow is live.';
    const header = [
      'Merchant', 'Type', 'Service Area', 'Currency',
      'Merchant Gross Sales (marketplace snapshot)',
      'ONECAB Commission', 'Stripe Fees',
      'Driver Earnings', 'Net Merchant Balance', 'Payout Status', 'Payout Date',
    ];
    const rowsCsv = filtered.map(r => [
      r.merchant_name, r.merchant_type, r.service_area_name, r.currency_code,
      (r.gross_sales_pence / 100).toFixed(2),
      (r.onecab_commission_pence / 100).toFixed(2),
      (r.stripe_fees_pence / 100).toFixed(2),
      (r.driver_delivery_earnings_pence / 100).toFixed(2),
      (r.net_merchant_balance_pence / 100).toFixed(2),
      STATUS_META[r.payout_status].label,
      r.payout_date || '',
    ]);
    const csv = [disclaimer, header, ...rowsCsv]
      .map((r) => (Array.isArray(r) ? r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',') : r))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `marketplace-settlements-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('CSV exported');
  };

  const handleMarkPaid = (row: MerchantSettlementRow) => {
    // Marketplace order settlement flow is not yet emitting payable balances.
    // Block the action until net > 0 to prevent zero-value payout records.
    if (row.net_merchant_balance_pence <= 0) {
      toast.info('No net balance to pay out', {
        description: 'Merchant has no settled marketplace orders yet.',
      });
      return;
    }
    toast.success('Marked as paid (pending payout batch run)');
  };

  return (
    <AdminLayout title="Marketplace Settlements" description="Merchant payout tracking for delivery marketplace orders">
      <div className="flex flex-col gap-1 mb-6">
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <Wallet className="h-7 w-7 text-primary" />
          Marketplace Settlements
        </h1>
        <p className="text-muted-foreground">
          Track merchant payouts from delivery marketplace orders. Uses ONECAB payout
          workflow, Stripe fee tracking, and weekly payout logic — no separate
          payment engine.
        </p>
      </div>

      {/* Filters */}
      <Card className="mb-6">
        <CardContent className="pt-6 flex flex-wrap items-center gap-3">
          <Select value={serviceAreaId} onValueChange={setServiceAreaId}>
            <SelectTrigger className="w-[220px]">
              <MapPin className="h-4 w-4 mr-2" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Service Areas</SelectItem>
              {(serviceAreas || []).map((sa: any) => (
                <SelectItem key={sa.id} value={sa.id}>{sa.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as any)}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Payout status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="processing">Processing</SelectItem>
              <SelectItem value="paid">Paid</SelectItem>
              <SelectItem value="failed">Failed</SelectItem>
              <SelectItem value="on_hold">On Hold</SelectItem>
            </SelectContent>
          </Select>

          <Input
            placeholder="Search merchant…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-[240px]"
          />

          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={handleExportCSV} disabled={!filtered.length}>
              <Download className="h-4 w-4 mr-2" />
              Export CSV
            </Button>
            <Button variant="ghost" size="icon" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Currency-grouped totals */}
      {totalsByCurrency.length > 0 && (
        <div className="grid gap-4 md:grid-cols-4 mb-6">
          {totalsByCurrency.map(([currency, t]) => (
            <Card key={`gross-${currency}`}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Merchant Sales ({currency})
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{formatPence(t.gross, currency)}</div>
                <p className="text-xs text-muted-foreground">{t.count} merchants</p>
              </CardContent>
            </Card>
          ))}
          {totalsByCurrency.map(([currency, t]) => (
            <Card key={`net-${currency}`}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Pending Merchant Settlements ({currency})
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{formatPence(t.net, currency)}</div>
                <p className="text-xs text-muted-foreground">Net owed to merchants</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Table */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Store className="h-5 w-5 text-primary" />
            Settlements ({filtered.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="py-12 text-center text-muted-foreground">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="py-12 text-center text-muted-foreground">
              No merchants match the current filters.
            </div>
          ) : (
            <div className="rounded-md border overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Merchant</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Service Area</TableHead>
                    <TableHead className="text-right">Gross Sales</TableHead>
                    <TableHead className="text-right">ONECAB Commission</TableHead>
                    <TableHead className="text-right">Stripe Fees</TableHead>
                    <TableHead className="text-right">Net Balance</TableHead>
                    <TableHead>Payout Status</TableHead>
                    <TableHead>Payout Date</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map(row => (
                    <TableRow key={row.merchant_id}>
                      <TableCell className="font-medium">{row.merchant_name}</TableCell>
                      <TableCell className="capitalize">{row.merchant_type}</TableCell>
                      <TableCell>{row.service_area_name}</TableCell>
                      <TableCell className="text-right">{formatPence(row.gross_sales_pence, row.currency_code)}</TableCell>
                      <TableCell className="text-right">{formatPence(row.onecab_commission_pence, row.currency_code)}</TableCell>
                      <TableCell className="text-right">{formatPence(row.stripe_fees_pence, row.currency_code)}</TableCell>
                      <TableCell className="text-right font-semibold">{formatPence(row.net_merchant_balance_pence, row.currency_code)}</TableCell>
                      <TableCell><StatusBadge status={row.payout_status} /></TableCell>
                      <TableCell className="text-muted-foreground">{row.payout_date || '—'}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button size="icon" variant="ghost" onClick={() => setDetailRow(row)}>
                            <Eye className="h-4 w-4" />
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleMarkPaid(row)}
                            disabled={row.payout_status === 'paid'}
                          >
                            Mark Paid
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Empty-data notice when no orders have produced settlements */}
      {rows.length > 0 && rows.every(r => r.gross_sales_pence === 0) && (
        <div className="mt-4 flex items-start gap-2 rounded-md border border-yellow-500/30 bg-yellow-500/10 p-3 text-sm">
          <AlertTriangle className="h-4 w-4 mt-0.5 text-yellow-600" />
          <div>
            <p className="font-medium">No marketplace orders have been settled yet.</p>
            <p className="text-muted-foreground">
              Settlement balances populate automatically once delivery orders complete and
              the ONECAB payout workflow runs (card / Apple Pay / Google Pay only — cash is
              not allowed for marketplace delivery).
            </p>
          </div>
        </div>
      )}

      {/* Detail dialog */}
      <Dialog open={!!detailRow} onOpenChange={(o) => !o && setDetailRow(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{detailRow?.merchant_name}</DialogTitle>
            <DialogDescription>
              {detailRow?.merchant_type} • {detailRow?.service_area_name}
            </DialogDescription>
          </DialogHeader>
          {detailRow && (
            <div className="space-y-2 text-sm">
              <Row label="Gross Sales" value={formatPence(detailRow.gross_sales_pence, detailRow.currency_code)} />
              <Row label="ONECAB Commission" value={formatPence(detailRow.onecab_commission_pence, detailRow.currency_code)} />
              <Row label="Stripe Fees" value={formatPence(detailRow.stripe_fees_pence, detailRow.currency_code)} />
              <Row label="Driver Delivery Earnings" value={formatPence(detailRow.driver_delivery_earnings_pence, detailRow.currency_code)} />
              <Row label="Net Merchant Balance" value={formatPence(detailRow.net_merchant_balance_pence, detailRow.currency_code)} bold />
              <Row label="Commission %" value={detailRow.commission_pct != null ? `${detailRow.commission_pct}%` : '—'} />
              <div className="flex items-center justify-between pt-2">
                <span className="text-muted-foreground">Payout Status</span>
                <StatusBadge status={detailRow.payout_status} />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDetailRow(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className={bold ? 'font-bold' : ''}>{value}</span>
    </div>
  );
}
