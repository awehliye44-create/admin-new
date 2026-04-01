import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import {
  Search, RefreshCw, Eye, Package, Clock, CheckCircle, AlertTriangle, XCircle, Loader2, Box, CalendarIcon,
} from 'lucide-react';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import { useLostPropertyCases, LP_STATUS_LABELS, LP_STATUS_COLORS } from '@/hooks/useLostProperty';
import { useServiceAreas } from '@/hooks/useServiceAreas';

const ALL_STATUSES = Object.keys(LP_STATUS_LABELS);

export default function LostProperty() {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [serviceAreaFilter, setServiceAreaFilter] = useState('all');
  const [dateFrom, setDateFrom] = useState<Date | undefined>();
  const [dateTo, setDateTo] = useState<Date | undefined>();

  const { data: cases = [], isLoading, refetch } = useLostPropertyCases({
    status: statusFilter,
    serviceAreaId: serviceAreaFilter,
    search: search.trim() || undefined,
    dateFrom: dateFrom ? dateFrom.toISOString() : undefined,
    dateTo: dateTo ? dateTo.toISOString() : undefined,
  });
  const { data: serviceAreas = [] } = useServiceAreas({ activeOnly: false });

  const saMap = new Map(serviceAreas.map(sa => [sa.id, sa.name]));

  // KPIs
  const totalOpen = cases.filter(c => c.status !== 'CLOSED').length;
  const newCases = cases.filter(c => c.status === 'NEW' || c.status === 'SENT_TO_DRIVER').length;
  const escalated = cases.filter(c => c.status === 'ESCALATED').length;
  const closed = cases.filter(c => c.status === 'CLOSED').length;

  const isUnread = (c: typeof cases[0]) => {
    if (c.status === 'NEW') return true;
    if (c.status === 'SENT_TO_DRIVER' && !c.admin_viewed_at) return true;
    if (!c.admin_viewed_at && c.status === 'ESCALATED') return true;
    return false;
  };

  return (
    <AdminLayout title="Lost Property" description="Manage lost property cases from completed trips">
      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-blue-500/10">
                <Package className="h-5 w-5 text-blue-500" />
              </div>
              <div>
                <p className="text-2xl font-bold">{totalOpen}</p>
                <p className="text-xs text-muted-foreground">Open Cases</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-yellow-500/10">
                <Clock className="h-5 w-5 text-yellow-500" />
              </div>
              <div>
                <p className="text-2xl font-bold">{newCases}</p>
                <p className="text-xs text-muted-foreground">New / Pending</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-red-500/10">
                <AlertTriangle className="h-5 w-5 text-red-500" />
              </div>
              <div>
                <p className="text-2xl font-bold">{escalated}</p>
                <p className="text-xs text-muted-foreground">Escalated</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-green-500/10">
                <CheckCircle className="h-5 w-5 text-green-500" />
              </div>
              <div>
                <p className="text-2xl font-bold">{closed}</p>
                <p className="text-xs text-muted-foreground">Closed</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <Card className="mb-6">
        <CardContent className="pt-4 pb-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search case ID, trip ID, description..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="pl-9"
              />
            </div>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                {ALL_STATUSES.map(s => (
                  <SelectItem key={s} value={s}>{LP_STATUS_LABELS[s]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={serviceAreaFilter} onValueChange={setServiceAreaFilter}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="Service Area" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Areas</SelectItem>
                {serviceAreas.map(sa => (
                  <SelectItem key={sa.id} value={sa.id}>{sa.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Date From */}
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" className={cn("w-[140px] justify-start text-left font-normal", !dateFrom && "text-muted-foreground")}>
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {dateFrom ? format(dateFrom, 'dd MMM yy') : 'From'}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar mode="single" selected={dateFrom} onSelect={setDateFrom} initialFocus className={cn("p-3 pointer-events-auto")} />
              </PopoverContent>
            </Popover>

            {/* Date To */}
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" className={cn("w-[140px] justify-start text-left font-normal", !dateTo && "text-muted-foreground")}>
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {dateTo ? format(dateTo, 'dd MMM yy') : 'To'}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar mode="single" selected={dateTo} onSelect={setDateTo} initialFocus className={cn("p-3 pointer-events-auto")} />
              </PopoverContent>
            </Popover>

            {(dateFrom || dateTo) && (
              <Button variant="ghost" size="sm" onClick={() => { setDateFrom(undefined); setDateTo(undefined); }}>
                Clear dates
              </Button>
            )}

            <Button variant="outline" size="icon" onClick={() => refetch()}>
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : cases.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <Box className="h-10 w-10 mb-3 opacity-40" />
              <p>No lost property cases found</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8"></TableHead>
                  <TableHead>Case ID</TableHead>
                  <TableHead>Trip ID</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Driver</TableHead>
                  <TableHead>Service Area</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Updated</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {cases.map(c => (
                  <TableRow
                    key={c.id}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => navigate(`/lost-property/${c.id}`)}
                  >
                    <TableCell>
                      {isUnread(c) && (
                        <span className="inline-block h-2.5 w-2.5 rounded-full bg-destructive" />
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{c.case_number}</TableCell>
                    <TableCell className="font-mono text-xs max-w-[100px] truncate">{c.trip_id?.slice(0, 8)}…</TableCell>
                    <TableCell className="text-sm">{c.customer_name || c.customer_id?.slice(0, 8) + '…'}</TableCell>
                    <TableCell className="text-sm">{c.driver_name || c.driver_id?.slice(0, 8) + '…'}</TableCell>
                    <TableCell className="text-sm">{saMap.get(c.service_area_id) || '—'}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="capitalize text-xs">{c.item_category}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge className={`${LP_STATUS_COLORS[c.status] || 'bg-gray-500'} text-white text-xs`}>
                        {LP_STATUS_LABELS[c.status] || c.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {format(new Date(c.updated_at), 'dd MMM HH:mm')}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" onClick={e => { e.stopPropagation(); navigate(`/lost-property/${c.id}`); }}>
                        <Eye className="h-4 w-4 mr-1" /> View
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </AdminLayout>
  );
}
