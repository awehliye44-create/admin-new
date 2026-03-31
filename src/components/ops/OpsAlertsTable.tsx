import { useState, useMemo } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Search, ChevronUp, ChevronDown } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { cn } from '@/lib/utils';

type OpsAlert = {
  id: string;
  fingerprint: string;
  category: string;
  severity: string;
  status: string;
  source: string;
  app: string | null;
  title: string;
  description: string | null;
  fingerprint_count: number;
  first_detected_at: string;
  last_detected_at: string;
  acknowledged_at: string | null;
  resolved_at: string | null;
  related_trip_id: string | null;
  related_driver_id: string | null;
  related_payment_id: string | null;
  related_payout_batch_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
};

interface OpsAlertsTableProps {
  alerts: OpsAlert[];
  loading: boolean;
  categoryFilter: string;
  onCategoryChange: (category: string) => void;
  onSelectAlert: (alert: OpsAlert) => void;
  title?: string;
}

const SEVERITY_COLORS: Record<string, string> = {
  fatal: 'bg-destructive text-destructive-foreground',
  critical: 'bg-destructive/80 text-destructive-foreground',
  warning: 'bg-amber-500/80 text-white',
  info: 'bg-muted text-muted-foreground',
};

const STATUS_COLORS: Record<string, string> = {
  open: 'bg-destructive/10 text-destructive border-destructive/30',
  acknowledged: 'bg-amber-500/10 text-amber-600 border-amber-500/30',
  resolved: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30',
  suppressed: 'bg-muted text-muted-foreground border-border',
};

type SortField = 'last_detected_at' | 'severity' | 'fingerprint_count';

export function OpsAlertsTable({ alerts, loading, categoryFilter, onCategoryChange, onSelectAlert, title }: OpsAlertsTableProps) {
  const [search, setSearch] = useState('');
  const [severityFilter, setSeverityFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [appFilter, setAppFilter] = useState('all');
  const [sortField, setSortField] = useState<SortField>('last_detected_at');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  // Derive unique app values for the app filter
  const appValues = useMemo(() => {
    const apps = new Set<string>();
    alerts.forEach(a => { if (a.app) apps.add(a.app); });
    return [...apps].sort();
  }, [alerts]);

  const filtered = useMemo(() => {
    let result = alerts;
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(a =>
        a.title.toLowerCase().includes(q) ||
        a.description?.toLowerCase().includes(q) ||
        a.fingerprint.toLowerCase().includes(q) ||
        a.related_trip_id?.toLowerCase().includes(q) ||
        a.related_driver_id?.toLowerCase().includes(q) ||
        a.related_payment_id?.toLowerCase().includes(q) ||
        a.app?.toLowerCase().includes(q)
      );
    }
    if (severityFilter !== 'all') result = result.filter(a => a.severity === severityFilter);
    if (statusFilter !== 'all') result = result.filter(a => a.status === statusFilter);
    if (appFilter !== 'all') result = result.filter(a => a.app === appFilter);

    result.sort((a, b) => {
      let cmp = 0;
      if (sortField === 'last_detected_at') cmp = new Date(a.last_detected_at).getTime() - new Date(b.last_detected_at).getTime();
      else if (sortField === 'fingerprint_count') cmp = a.fingerprint_count - b.fingerprint_count;
      else if (sortField === 'severity') {
        const order = { fatal: 4, critical: 3, warning: 2, info: 1 };
        cmp = (order[a.severity as keyof typeof order] || 0) - (order[b.severity as keyof typeof order] || 0);
      }
      return sortDir === 'desc' ? -cmp : cmp;
    });
    return result;
  }, [alerts, search, severityFilter, statusFilter, appFilter, sortField, sortDir]);

  const toggleSort = (field: SortField) => {
    if (sortField === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortField(field); setSortDir('desc'); }
  };

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return null;
    return sortDir === 'desc' ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" />;
  };

  return (
    <Card className="mt-4">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg">{title || 'Live Alerts'}</CardTitle>
          <span className="text-xs text-muted-foreground">{filtered.length} alert{filtered.length !== 1 ? 's' : ''}</span>
        </div>
        <div className="flex flex-wrap gap-3 mt-3">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search alerts, trip IDs, drivers..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          {!title && (
            <Select value={categoryFilter} onValueChange={onCategoryChange}>
              <SelectTrigger className="w-[160px]"><SelectValue placeholder="Category" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Categories</SelectItem>
                <SelectItem value="payment">Payment</SelectItem>
                <SelectItem value="commission">Commission</SelectItem>
                <SelectItem value="earning">Earning</SelectItem>
                <SelectItem value="payout">Payout</SelectItem>
                <SelectItem value="dispatch">Dispatch</SelectItem>
                <SelectItem value="guest_booking">Guest Booking</SelectItem>
                <SelectItem value="corporate_booking">Corporate Booking</SelectItem>
                <SelectItem value="customer_app">Customer App</SelectItem>
                <SelectItem value="driver_app">Driver App</SelectItem>
                <SelectItem value="backend">Backend</SelectItem>
                <SelectItem value="logs">Logs</SelectItem>
                <SelectItem value="duplication">Duplication</SelectItem>
                <SelectItem value="system">System</SelectItem>
              </SelectContent>
            </Select>
          )}
          <Select value={severityFilter} onValueChange={setSeverityFilter}>
            <SelectTrigger className="w-[130px]"><SelectValue placeholder="Severity" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Severities</SelectItem>
              <SelectItem value="fatal">Fatal</SelectItem>
              <SelectItem value="critical">Critical</SelectItem>
              <SelectItem value="warning">Warning</SelectItem>
              <SelectItem value="info">Info</SelectItem>
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[130px]"><SelectValue placeholder="Status" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="open">Open</SelectItem>
              <SelectItem value="acknowledged">Acknowledged</SelectItem>
              <SelectItem value="resolved">Resolved</SelectItem>
              <SelectItem value="suppressed">Suppressed</SelectItem>
            </SelectContent>
          </Select>
          <Select value={appFilter} onValueChange={setAppFilter}>
            <SelectTrigger className="w-[130px]"><SelectValue placeholder="App" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Apps</SelectItem>
              {appValues.map(app => (
                <SelectItem key={app} value={app}>{app}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Severity</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Title</TableHead>
              <TableHead>App</TableHead>
              <TableHead className="cursor-pointer select-none" onClick={() => toggleSort('fingerprint_count')}>
                <div className="flex items-center gap-1">Count <SortIcon field="fingerprint_count" /></div>
              </TableHead>
              <TableHead className="cursor-pointer select-none" onClick={() => toggleSort('last_detected_at')}>
                <div className="flex items-center gap-1">Last Detected <SortIcon field="last_detected_at" /></div>
              </TableHead>
              <TableHead>Source</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow><TableCell colSpan={8} className="text-center py-8 text-muted-foreground">Loading alerts...</TableCell></TableRow>
            ) : filtered.length === 0 ? (
              <TableRow><TableCell colSpan={8} className="text-center py-8 text-muted-foreground">No alerts found — system healthy ✓</TableCell></TableRow>
            ) : (
              filtered.map(alert => (
                <TableRow
                  key={alert.id}
                  className="cursor-pointer hover:bg-accent/50"
                  onClick={() => onSelectAlert(alert)}
                >
                  <TableCell>
                    <Badge className={cn('text-[10px]', SEVERITY_COLORS[alert.severity])}>
                      {alert.severity.toUpperCase()}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className={cn('text-[10px]', STATUS_COLORS[alert.status])}>
                      {alert.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{alert.category.replace(/_/g, ' ')}</TableCell>
                  <TableCell className="max-w-[300px]">
                    <p className="text-sm font-medium truncate">{alert.title}</p>
                    {alert.description && (
                      <p className="text-xs text-muted-foreground truncate">{alert.description}</p>
                    )}
                  </TableCell>
                  <TableCell>
                    {alert.app && (
                      <Badge variant="secondary" className="text-[10px]">{alert.app}</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {alert.fingerprint_count > 1 && (
                      <Badge variant="secondary" className="text-[10px]">×{alert.fingerprint_count}</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                    {formatDistanceToNow(new Date(alert.last_detected_at), { addSuffix: true })}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{alert.source}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
