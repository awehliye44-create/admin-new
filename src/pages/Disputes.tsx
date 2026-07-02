import { useState, useMemo } from 'react';
import { formatPence } from '@/hooks/useDriverWallet';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { supabase } from '@/integrations/supabase/client';
import { useQuery } from '@tanstack/react-query';
import { NewAdjustmentDialog } from '@/components/adjustments/NewAdjustmentDialog';
import { ServiceAreaFinanceFilter, DEFAULT_SERVICE_AREA_SELECTION, type ServiceAreaFinanceSelection } from '@/components/finance/ServiceAreaFinanceFilter';
import { FinanceSsotOperationalNotice } from '@/components/finance/FinanceSSOTBadge';
import { CurrencyGroupedStats, getSingleCurrency } from '@/components/finance/CurrencyGroupedStats';
import { useServiceAreasMap } from '@/hooks/useServiceAreas';
import {
  Search,
  RefreshCw,
  Plus,
  TrendingUp,
  TrendingDown,
  Scale,
  ArrowUpCircle,
  ArrowDownCircle,
  Receipt,
  AlertTriangle,
} from 'lucide-react';

interface AdjustmentEntry {
  id: string;
  driver_id: string;
  driver_name: string;
  driver_code: string | null;
  driver_region_id: string | null;
  entry_type: string;
  amount_pence: number;
  currency_code: string;
  description: string | null;
  trip_id: string | null;
  reference_id: string | null;
  created_at: string;
}

const ADJUSTMENT_TYPES = ['ADJUSTMENT', 'BONUS', 'REFUND_DEBIT', 'CASHOUT_FEE'];

export default function Disputes() {
  const [activeTab, setActiveTab] = useState('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [showNewDialog, setShowNewDialog] = useState(false);
  const [serviceFilter, setServiceFilter] = useState<ServiceAreaFinanceSelection>(DEFAULT_SERVICE_AREA_SELECTION);

  const { data: allAdjustments = [], isLoading, refetch } = useQuery({
    queryKey: ['adjustments-ledger'],
    queryFn: async () => {
      const { data: ledger, error } = await supabase
        .from('driver_wallet_ledger')
        .select('id, driver_id, type, amount_pence, currency, description, related_trip_id, created_at')
        .in('type', ADJUSTMENT_TYPES)
        .order('created_at', { ascending: false })
        .limit(200);

      if (error) throw error;

      const driverIds = [...new Set(ledger?.map((l) => l.driver_id) || [])];
      let driversMap: Record<string, { name: string; code: string | null; region_id: string | null }> = {};

      if (driverIds.length > 0) {
        const { data: drivers } = await supabase
          .from('drivers')
          .select('id, first_name, last_name, driver_code, region_id')
          .in('id', driverIds);

        driversMap = (drivers || []).reduce((acc, d) => {
          acc[d.id] = { name: `${d.first_name} ${d.last_name}`, code: d.driver_code, region_id: d.region_id };
          return acc;
        }, {} as Record<string, { name: string; code: string | null; region_id: string | null }>);
      }

      return (ledger || []).map((l) => ({
        ...l,
        // Remap wallet_ledger columns to legacy names used in the UI
        entry_type: l.type,
        currency_code: l.currency,
        trip_id: l.related_trip_id,
        driver_name: driversMap[l.driver_id]?.name || 'Unknown',
        driver_code: driversMap[l.driver_id]?.code || null,
        driver_region_id: driversMap[l.driver_id]?.region_id || null,
      }));
    },
  });

  // Get service areas for region mapping
  const { map: saMap } = useServiceAreasMap();

  // Filter adjustments by selected service area's region
  const adjustments = useMemo(() => {
    if (!serviceFilter.regionId) return allAdjustments;
    return allAdjustments.filter(a => a.driver_region_id === serviceFilter.regionId);
  }, [allAdjustments, serviceFilter.regionId]);

  // Resolved currency
  const resolvedCurrency = serviceFilter.currencyCode || getSingleCurrency(adjustments) || '';
  const isMixedCurrency = !serviceFilter.currencyCode && !getSingleCurrency(adjustments) && adjustments.length > 0;

  // Stats
  const totalCredits = adjustments
    .filter((a) => a.amount_pence > 0)
    .reduce((sum, a) => sum + a.amount_pence, 0);
  const totalDebits = adjustments
    .filter((a) => a.amount_pence < 0)
    .reduce((sum, a) => sum + Math.abs(a.amount_pence), 0);
  const netAmount = totalCredits - totalDebits;

  const getTypeBadge = (type: string) => {
    const config: Record<string, { variant: 'default' | 'secondary' | 'destructive' | 'outline'; className?: string }> = {
      ADJUSTMENT: { variant: 'outline' },
      BONUS: { variant: 'default', className: 'bg-emerald-600' },
      REFUND_DEBIT: { variant: 'destructive' },
      CASHOUT_FEE: { variant: 'secondary' },
    };
    const { variant, className } = config[type] || { variant: 'outline' };
    return (
      <Badge variant={variant} className={className}>
        {type.replace(/_/g, ' ')}
      </Badge>
    );
  };

  const filteredAdjustments = adjustments.filter((a) => {
    const matchesSearch =
      a.driver_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      a.description?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      a.driver_code?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      a.id.toLowerCase().includes(searchTerm.toLowerCase());

    if (activeTab === 'all') return matchesSearch;
    return matchesSearch && a.entry_type === activeTab;
  });

  if (isLoading) {
    return (
      <AdminLayout title="Disputes & Adjustments" description="Financial adjustments">
        <div className="flex items-center justify-center h-64">
          <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout
      title="Disputes & Adjustments"
      description="Manage driver financial adjustments, bonuses and deductions"
    >
      <div className="space-y-6">
        <FinanceSsotOperationalNotice />
        {/* Service Area Filter */}
        <div className="flex items-center gap-3">
          <ServiceAreaFinanceFilter value={serviceFilter} onChange={setServiceFilter} />
          {isMixedCurrency && (
            <Badge variant="outline" className="text-amber-600 border-amber-300">
              <AlertTriangle className="h-3 w-3 mr-1" /> Mixed currencies — select a service for totals
            </Badge>
          )}
        </div>

        {/* Stats */}
        <div className="grid gap-4 md:grid-cols-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Adjustments</CardTitle>
              <Receipt className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{adjustments.length}</div>
              <p className="text-xs text-muted-foreground">All time</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Credits</CardTitle>
              <TrendingUp className="h-4 w-4 text-emerald-500" />
            </CardHeader>
            <CardContent>
              {isMixedCurrency ? (
                <CurrencyGroupedStats items={adjustments.filter(a => a.amount_pence > 0).map(a => ({ currency_code: a.currency_code, amount: a.amount_pence }))} className="text-lg font-bold text-emerald-500" />
              ) : (
                <div className="text-2xl font-bold text-emerald-500">{formatPence(totalCredits, resolvedCurrency)}</div>
              )}
              <p className="text-xs text-muted-foreground">Paid to drivers</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Debits</CardTitle>
              <TrendingDown className="h-4 w-4 text-destructive" />
            </CardHeader>
            <CardContent>
              {isMixedCurrency ? (
                <CurrencyGroupedStats items={adjustments.filter(a => a.amount_pence < 0).map(a => ({ currency_code: a.currency_code, amount: Math.abs(a.amount_pence) }))} className="text-lg font-bold text-destructive" />
              ) : (
                <div className="text-2xl font-bold text-destructive">{formatPence(totalDebits, resolvedCurrency)}</div>
              )}
              <p className="text-xs text-muted-foreground">Deducted from drivers</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Net Impact</CardTitle>
              <Scale className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              {isMixedCurrency ? (
                <CurrencyGroupedStats 
                  items={adjustments.map(a => ({ currency_code: a.currency_code, amount: a.amount_pence }))} 
                  className="text-lg font-bold" 
                />
              ) : (
                <div className={`text-2xl font-bold ${netAmount >= 0 ? 'text-emerald-500' : 'text-destructive'}`}>
                  {netAmount >= 0 ? '+' : '-'}{formatPence(Math.abs(netAmount), resolvedCurrency)}
                </div>
              )}
              <p className="text-xs text-muted-foreground">Credits − Debits</p>
            </CardContent>
          </Card>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
          <div className="flex flex-col sm:flex-row justify-between gap-4">
            <TabsList>
              <TabsTrigger value="all">All ({adjustments.length})</TabsTrigger>
              <TabsTrigger value="ADJUSTMENT">Adjustments</TabsTrigger>
              <TabsTrigger value="BONUS">Bonuses</TabsTrigger>
              <TabsTrigger value="REFUND_DEBIT">Refund Debits</TabsTrigger>
              <TabsTrigger value="CASHOUT_FEE">Cashout Fees</TabsTrigger>
            </TabsList>

            <div className="flex gap-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search driver or reason..."
                  className="pl-9 w-[220px]"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
              </div>
              <Button variant="outline" size="icon" onClick={() => refetch()}>
                <RefreshCw className="h-4 w-4" />
              </Button>
              <Button onClick={() => setShowNewDialog(true)}>
                <Plus className="h-4 w-4 mr-2" />
                New Adjustment
              </Button>
            </div>
          </div>

          <TabsContent value={activeTab} className="m-0">
            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Driver</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Reason</TableHead>
                      <TableHead>Trip</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredAdjustments.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                          No adjustments found
                        </TableCell>
                      </TableRow>
                    ) : (
                      filteredAdjustments.map((entry) => (
                        <TableRow key={entry.id}>
                          <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                            {new Date(entry.created_at).toLocaleDateString('en-GB', {
                              day: '2-digit',
                              month: 'short',
                              year: 'numeric',
                            })}
                          </TableCell>
                          <TableCell>
                            <div>
                              <p className="font-medium text-sm">{entry.driver_name}</p>
                              {entry.driver_code && (
                                <p className="text-xs text-muted-foreground font-mono">{entry.driver_code}</p>
                              )}
                            </div>
                          </TableCell>
                          <TableCell>{getTypeBadge(entry.entry_type)}</TableCell>
                          <TableCell>
                            <p className="text-sm truncate max-w-[250px]">
                              {entry.description || '—'}
                            </p>
                          </TableCell>
                          <TableCell>
                            {entry.trip_id ? (
                              <span className="font-mono text-xs text-muted-foreground">
                                {entry.trip_id.substring(0, 8)}…
                              </span>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex items-center justify-end gap-1">
                              {entry.amount_pence >= 0 ? (
                                <ArrowUpCircle className="h-4 w-4 text-emerald-500" />
                              ) : (
                                <ArrowDownCircle className="h-4 w-4 text-destructive" />
                              )}
                              <span
                                className={`font-semibold ${
                                  entry.amount_pence >= 0 ? 'text-emerald-500' : 'text-destructive'
                                }`}
                              >
                                {entry.amount_pence >= 0 ? '+' : '-'}{formatPence(Math.abs(entry.amount_pence), entry.currency_code)}
                              </span>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>

      <NewAdjustmentDialog open={showNewDialog} onOpenChange={setShowNewDialog} />
    </AdminLayout>
  );
}
