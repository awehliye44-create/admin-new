/**
 * Admin Customer Receivables — read-only Finance page.
 * Lists OPEN/RESERVED/SETTLED receivables with event history.
 * No Waive / no balance edit.
 */
import { useMemo, useState, Fragment } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { RefreshCw, Receipt } from 'lucide-react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { formatMoneyMinor } from '@/lib/formatMoneyMinor';

export type AdminCustomerReceivableRow = {
  id: string;
  customer_id: string;
  customer_display_name: string | null;
  customer_email: string | null;
  source_trip_id: string;
  source_trip_code: string | null;
  source_failed_authorisation: string | null;
  source_authorisation_id: string | null;
  source_type: string;
  reason_code: string;
  original_amount_pence: number;
  outstanding_amount_pence: number;
  status: string;
  currency: string;
  reserved_payment_session_id: string | null;
  reserved_session_status: string | null;
  recovery_provider_order_id: string | null;
  recovery_captured_amount_pence: number | null;
  created_at: string | null;
  settled_at: string | null;
  waived_at: string | null;
  events: Array<{
    id: string;
    event_type: string;
    amount_pence: number;
    note: string | null;
    created_at: string;
  }>;
};

type ListResponse = {
  success: boolean;
  ledger_available?: boolean;
  message?: string;
  open_outstanding_pence?: number;
  receivables?: AdminCustomerReceivableRow[];
  error?: string;
};

function statusBadge(status: string) {
  const s = status.toUpperCase();
  if (s === 'OPEN') return <Badge variant="destructive">OPEN</Badge>;
  if (s === 'RESERVED') return <Badge className="bg-amber-600">RESERVED</Badge>;
  if (s === 'SETTLED') return <Badge className="bg-emerald-600">SETTLED</Badge>;
  if (s === 'MANUAL_REVIEW') return <Badge variant="secondary">MANUAL REVIEW</Badge>;
  if (s === 'WAIVED') return <Badge variant="outline">WAIVED</Badge>;
  return <Badge variant="outline">{status}</Badge>;
}

function fmtTs(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default function CustomerReceivables() {
  const [statusFilter, setStatusFilter] = useState<string>('active');
  const [search, setSearch] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const rpcStatus = statusFilter === 'active' || statusFilter === 'all'
    ? null
    : statusFilter.toUpperCase();

  const query = useQuery({
    queryKey: ['admin-customer-receivables', rpcStatus],
    queryFn: async (): Promise<ListResponse> => {
      const { data, error } = await supabase.functions.invoke('admin-customer-receivables', {
        body: {
          status: rpcStatus,
          limit: 200,
          include_events: true,
        },
      });
      if (error) throw error;
      return (data ?? { success: false }) as ListResponse;
    },
    staleTime: 30_000,
  });

  const rows = useMemo(() => {
    let list = query.data?.receivables ?? [];
    if (statusFilter === 'active') {
      list = list.filter((r) => r.status === 'OPEN' || r.status === 'RESERVED' || r.status === 'MANUAL_REVIEW');
    }
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((r) =>
      [
        r.customer_display_name,
        r.customer_email,
        r.customer_id,
        r.source_trip_code,
        r.source_trip_id,
        r.recovery_provider_order_id,
        r.source_failed_authorisation,
        r.status,
      ]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q))
    );
  }, [query.data?.receivables, search, statusFilter]);

  const openTotal = query.data?.open_outstanding_pence ?? 0;

  return (
    <AdminLayout
      title="Customer Receivables"
      description="Read-only outstanding customer debt (next-booking recovery). No waive / no balance edit."
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <Input
            placeholder="Search customer, trip, order…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="max-w-sm"
          />
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="active">Active (open/reserved)</SelectItem>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="OPEN">OPEN</SelectItem>
              <SelectItem value="RESERVED">RESERVED</SelectItem>
              <SelectItem value="SETTLED">SETTLED</SelectItem>
              <SelectItem value="MANUAL_REVIEW">MANUAL_REVIEW</SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
          >
            <RefreshCw className={`h-4 w-4 mr-1 ${query.isFetching ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Link
            to="/financial-reconciliation?tab=overview"
            className="text-xs underline text-muted-foreground"
          >
            Financial Reconciliation
          </Link>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Card>
            <CardContent className="pt-4 pb-4">
              <p className="text-xs text-muted-foreground">Customer outstanding (open/reserved)</p>
              <p className="text-xl font-semibold mt-1">
                {formatMoneyMinor(openTotal, 'gbp')}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-4">
              <p className="text-xs text-muted-foreground">Rows shown</p>
              <p className="text-xl font-semibold mt-1">{rows.length}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-4">
              <p className="text-xs text-muted-foreground">Actions</p>
              <p className="text-sm mt-1 text-muted-foreground">
                Read-only — Waive and balance edit are forbidden in this release.
              </p>
            </CardContent>
          </Card>
        </div>

        {query.data?.ledger_available === false ? (
          <Card>
            <CardContent className="pt-4 text-sm text-muted-foreground">
              {query.data.message
                ?? 'Receivables ledger migration not applied yet. Display will populate after release approval.'}
            </CardContent>
          </Card>
        ) : null}

        {query.isError ? (
          <Card>
            <CardContent className="pt-4 text-sm text-destructive">
              {(query.error as Error)?.message ?? 'Failed to load receivables'}
            </CardContent>
          </Card>
        ) : null}

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Receipt className="h-4 w-4" />
              Receivables
            </CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Customer</TableHead>
                  <TableHead>Source trip</TableHead>
                  <TableHead>Failed auth</TableHead>
                  <TableHead>Original</TableHead>
                  <TableHead>Outstanding</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Reserved session</TableHead>
                  <TableHead>Recovery order</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Settled</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 && !query.isLoading ? (
                  <TableRow>
                    <TableCell colSpan={10} className="text-muted-foreground text-sm">
                      No receivables match this filter.
                    </TableCell>
                  </TableRow>
                ) : null}
                {rows.map((r) => (
                  <Fragment key={r.id}>
                    <TableRow
                      className="cursor-pointer"
                      onClick={() => setExpandedId(expandedId === r.id ? null : r.id)}
                    >
                      <TableCell className="text-sm">
                        <div className="font-medium">{r.customer_display_name ?? '—'}</div>
                        <div className="text-xs text-muted-foreground truncate max-w-[160px]">
                          {r.customer_email ?? r.customer_id.slice(0, 8)}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm">
                        <div>{r.source_trip_code ?? '—'}</div>
                        <div className="text-xs text-muted-foreground font-mono">
                          {r.source_trip_id.slice(0, 8)}…
                        </div>
                      </TableCell>
                      <TableCell className="text-xs font-mono max-w-[120px] truncate">
                        {r.source_failed_authorisation ?? '—'}
                      </TableCell>
                      <TableCell className="text-sm">
                        {formatMoneyMinor(r.original_amount_pence, r.currency)}
                      </TableCell>
                      <TableCell className="text-sm font-medium">
                        {formatMoneyMinor(r.outstanding_amount_pence, r.currency)}
                      </TableCell>
                      <TableCell>{statusBadge(r.status)}</TableCell>
                      <TableCell className="text-xs font-mono">
                        {r.reserved_payment_session_id
                          ? `${r.reserved_payment_session_id.slice(0, 8)}…`
                          : '—'}
                        {r.reserved_session_status
                          ? (
                            <div className="text-muted-foreground">{r.reserved_session_status}</div>
                            )
                          : null}
                      </TableCell>
                      <TableCell className="text-xs font-mono max-w-[140px] truncate">
                        {r.recovery_provider_order_id ?? '—'}
                      </TableCell>
                      <TableCell className="text-xs whitespace-nowrap">{fmtTs(r.created_at)}</TableCell>
                      <TableCell className="text-xs whitespace-nowrap">{fmtTs(r.settled_at)}</TableCell>
                    </TableRow>
                    {expandedId === r.id ? (
                      <TableRow>
                        <TableCell colSpan={10} className="bg-muted/40">
                          <p className="text-xs font-medium mb-2">Event history</p>
                          {(r.events ?? []).length === 0 ? (
                            <p className="text-xs text-muted-foreground">No events.</p>
                          ) : (
                            <ul className="space-y-1 text-xs">
                              {r.events.map((e) => (
                                <li key={e.id} className="flex flex-wrap gap-2">
                                  <Badge variant="outline">{e.event_type}</Badge>
                                  <span>{formatMoneyMinor(e.amount_pence ?? 0, r.currency)}</span>
                                  <span className="text-muted-foreground">{fmtTs(e.created_at)}</span>
                                  {e.note ? <span className="text-muted-foreground">— {e.note}</span> : null}
                                </li>
                              ))}
                            </ul>
                          )}
                          <p className="text-[11px] text-muted-foreground mt-2">
                            Reason: {r.reason_code} · Type: {r.source_type}
                          </p>
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </AdminLayout>
  );
}
