import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { supabase } from '@/integrations/supabase/client';
import { getCurrencySymbol } from '@/lib/regionSettings';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { toast } from 'sonner';
import {
  useDriverFinancialSummaries,
  useDriverFinancialSummary,
  useDriverLedger,
  formatPence,
  getEntryTypeDisplay,
  type DriverFinancialSummary,
} from '@/hooks/useDriverWallet';
import {
  ServiceAreaFinanceFilter,
  DEFAULT_SERVICE_AREA_SELECTION,
  type ServiceAreaFinanceSelection,
} from '@/components/finance/ServiceAreaFinanceFilter';
import { CurrencyGroupedStats, getSingleCurrency } from '@/components/finance/CurrencyGroupedStats';
import { FinanceReconciliationTotalsCards } from '@/components/finance/FinanceReconciliationTotalsCards';
import { useFinancialReconciliationSSOT } from '@/hooks/useFinancialReconciliationSSOT';
import { FinanceSSOTBadge } from '@/components/finance/FinanceSSOTBadge';
import { DriverSSOTPayoutPanel, useDriverSSOTPayoutGate } from '@/components/finance/DriverSSOTPayoutPanel';
import { ManualPayoutConfirmDialog } from '@/components/finance/ManualPayoutConfirmDialog';
import { OnecabCommissionVisibility } from '@/components/finance/OnecabCommissionVisibility';
import { FinanceLedgerPanel } from '@/components/finance/FinanceLedgerPanel';
import { MANUAL_PAYOUT_NO_SSOT_BALANCE_MESSAGE } from '@/lib/manualPayoutGate';
import { FinancePayoutAuditSection } from '@/components/finance/FinancePayoutAuditSection';
import { MondayPayoutDiagnosticsTable } from '@/components/finance/MondayPayoutDiagnosticsTable';
import { retryMondayPayoutItem, useMondayPayoutDiagnostics } from '@/hooks/useMondayPayoutDiagnostics';
import { MONDAY_PAYOUT_DIAGNOSTICS_OPTS } from '@/lib/financePageSSOT';
import {
  Search,
  Eye,
  RefreshCw,
  User,
  Banknote,
  Wallet,
  CheckCircle2,
  AlertTriangle,
  CreditCard,
  Plus,
  Minus,
  ArrowDownRight,
  ArrowUpRight,
  TrendingDown,
  BookOpen,
  Users,
} from 'lucide-react';

type MainSection = 'overview' | 'ledger';
type DriverFilter = 'all' | 'payable' | 'in_debt' | 'positive';

export default function DriversAndPayouts() {
  const [searchParams, setSearchParams] = useSearchParams();
  const mainSection = (searchParams.get('tab') === 'ledger' ? 'ledger' : 'overview') as MainSection;

  const [driverFilter, setDriverFilter] = useState<DriverFilter>('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedDriverId, setSelectedDriverId] = useState<string | null>(null);
  const [showAdjustmentDialog, setShowAdjustmentDialog] = useState(false);
  const [adjustmentAmount, setAdjustmentAmount] = useState('');
  const [adjustmentReason, setAdjustmentReason] = useState('');
  const [adjustmentType, setAdjustmentType] = useState<'add' | 'deduct'>('add');
  const [serviceFilter, setServiceFilter] = useState<ServiceAreaFinanceSelection>(DEFAULT_SERVICE_AREA_SELECTION);
  const [retryingPayoutId, setRetryingPayoutId] = useState<string | null>(null);
  const [showPayoutConfirm, setShowPayoutConfirm] = useState(false);

  const queryClient = useQueryClient();
  const financeSSOT = useFinancialReconciliationSSOT({ filter: serviceFilter });
  const mondayPayouts = useMondayPayoutDiagnostics(serviceFilter, {
    driverId: selectedDriverId,
    ...MONDAY_PAYOUT_DIAGNOSTICS_OPTS,
  });

  const { data: allDrivers = [], isLoading, refetch } = useDriverFinancialSummaries();
  const { data: selectedDriverDetail } = useDriverFinancialSummary(selectedDriverId);
  const { data: ledgerEntries = [], isLoading: isLoadingLedger } = useDriverLedger(selectedDriverId, 100);

  const { data: inFlightPayout } = useQuery({
    queryKey: ['driver-inflight-payout', selectedDriverId],
    enabled: !!selectedDriverId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('payout_items')
        .select('id, status, settlement_status, stripe_transfer_id')
        .eq('driver_id', selectedDriverId!)
        .in('status', ['pending', 'processing', 'ledger_sync_failed'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      if (data.status === 'ledger_sync_failed') return data;
      const settlement = String(data.settlement_status ?? '').toUpperCase();
      if (settlement !== 'COMPLETE' && settlement !== 'FAILED' && !data.stripe_transfer_id) {
        return data;
      }
      return null;
    },
  });

  const driverPayoutGate = useDriverSSOTPayoutGate(
    selectedDriverId,
    serviceFilter,
    selectedDriverDetail
      ? {
          stripe_account_id: selectedDriverDetail.stripe_account_id,
          onboarding_complete: selectedDriverDetail.onboarding_complete,
          payouts_enabled: selectedDriverDetail.payouts_enabled,
          amount_owed_to_onecab: selectedDriverDetail.amount_owed_to_onecab,
          card_net_credits: selectedDriverDetail.card_net_credits,
        }
      : null,
    !!inFlightPayout,
  );

  const drivers = useMemo(() => {
    if (!serviceFilter.regionId) return allDrivers;
    return allDrivers.filter((d) => d.region_id === serviceFilter.regionId);
  }, [allDrivers, serviceFilter.regionId]);

  const resolvedCurrency = serviceFilter.currencyCode || getSingleCurrency(drivers) || '';
  const isMixedCurrency = !serviceFilter.currencyCode && !getSingleCurrency(drivers) && drivers.length > 0;

  const driversPayable = drivers.filter((d) => d.net_available_for_payout > 0 || d.available_for_payout > 0).length;
  const driversInDebt = drivers.filter((d) => d.amount_owed_to_onecab > 0).length;
  const driversWithBalance = drivers.filter((d) => d.wallet_balance > 0).length;

  const filteredDrivers = useMemo(() => {
    return drivers.filter((d) => {
      const name = `${d.first_name} ${d.last_name}`.toLowerCase();
      const matchesSearch =
        name.includes(searchTerm.toLowerCase()) ||
        d.email.toLowerCase().includes(searchTerm.toLowerCase());
      if (driverFilter === 'payable') {
        return matchesSearch && (d.net_available_for_payout > 0 || d.available_for_payout > 0);
      }
      if (driverFilter === 'in_debt') return matchesSearch && d.amount_owed_to_onecab > 0;
      if (driverFilter === 'positive') return matchesSearch && d.wallet_balance > 0;
      return matchesSearch;
    });
  }, [drivers, searchTerm, driverFilter]);

  const setMainSection = (section: MainSection) => {
    setSearchParams(section === 'ledger' ? { tab: 'ledger' } : {}, { replace: true });
  };

  useEffect(() => {
    if (searchParams.get('tab') === 'ledger') {
      setDriverFilter('all');
    }
  }, [searchParams]);

  const adjustmentMutation = useMutation({
    mutationFn: async ({ driverId, amountPence, reason }: { driverId: string; amountPence: number; reason: string }) => {
      const { data, error } = await supabase.functions.invoke('admin-driver-adjustment', {
        body: { driver_id: driverId, amount_pence: amountPence, reason },
      });
      if (error) throw error;
      if (!data.success) throw new Error(data.error || 'Adjustment failed');
      return data;
    },
    onSuccess: () => {
      toast.success('Adjustment added successfully');
      setShowAdjustmentDialog(false);
      setAdjustmentAmount('');
      setAdjustmentReason('');
      queryClient.invalidateQueries({ queryKey: ['driver-financial-summaries'] });
      queryClient.invalidateQueries({ queryKey: ['driver-financial-summary', selectedDriverId] });
      queryClient.invalidateQueries({ queryKey: ['driver-ledger', selectedDriverId] });
      queryClient.invalidateQueries({ queryKey: ['finance-ledger-transactions'] });
      queryClient.invalidateQueries({ queryKey: ['per-driver-finance-ssot', selectedDriverId] });
      financeSSOT.refetch();
    },
    onError: (error: Error) => toast.error(`Adjustment failed: ${error.message}`),
  });

  const payoutMutation = useMutation({
    mutationFn: async (driverId: string) => {
      const { data, error } = await supabase.functions.invoke('admin-driver-payout', {
        body: { driver_id: driverId, confirm_payout: true },
      });
      if (error) throw error;
      if (!data?.success) {
        const err = new Error(data?.error || 'Payout failed') as Error & { data?: typeof data };
        err.data = data;
        throw err;
      }
      return data;
    },
    onSuccess: (data) => {
      if (data?.dry_run || data?.stripe_execution_disabled) {
        toast.success('Payout batch created (Stripe execution disabled — dry run mode)');
      } else {
        toast.success('Payout initiated successfully');
      }
      setShowPayoutConfirm(false);
      queryClient.invalidateQueries({ queryKey: ['driver-financial-summaries'] });
      queryClient.invalidateQueries({ queryKey: ['driver-financial-summary', selectedDriverId] });
      queryClient.invalidateQueries({ queryKey: ['finance-ledger-transactions'] });
      queryClient.invalidateQueries({ queryKey: ['per-driver-finance-ssot', selectedDriverId] });
      driverPayoutGate.refetch();
      financeSSOT.refetch();
    },
    onError: (error: Error & { data?: { error?: string } }) => {
      toast.error(error.data?.error || error.message);
    },
  });

  const handleRetryPayout = async (row: Parameters<typeof retryMondayPayoutItem>[0]) => {
    setRetryingPayoutId(row.payout_item_id);
    try {
      await retryMondayPayoutItem(row);
      toast.success('Payout retry initiated');
      await mondayPayouts.refetch();
      queryClient.invalidateQueries({ queryKey: ['driver-financial-summaries'] });
      financeSSOT.refetch();
    } catch (e) {
      toast.error(`Retry failed: ${(e as Error).message}`);
    } finally {
      setRetryingPayoutId(null);
    }
  };

  const handleAddAdjustment = () => {
    if (!selectedDriverId || !adjustmentAmount || !adjustmentReason) {
      toast.error('Please fill in all fields');
      return;
    }
    const amountPence = Math.round(parseFloat(adjustmentAmount) * 100);
    const finalAmount = adjustmentType === 'deduct' ? -amountPence : amountPence;
    adjustmentMutation.mutate({ driverId: selectedDriverId, amountPence: finalAmount, reason: adjustmentReason });
  };

  const dFmt = (d: DriverFinancialSummary, pence: number) => formatPence(pence, d.currency_code);

  if (isLoading && drivers.length === 0) {
    return (
      <AdminLayout title="Drivers & Payouts" description="Driver wallets, settlements, and ledger audit">
        <div className="flex items-center justify-center h-64">
          <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout
      title="Drivers & Payouts"
      description="Driver wallet balances, manual payouts, adjustments, and full ledger audit"
    >
      <div className="space-y-6">
        <FinanceReconciliationTotalsCards ssot={financeSSOT} />
        <OnecabCommissionVisibility
          summary={financeSSOT.summary}
          currencyCode={resolvedCurrency}
          filter={serviceFilter}
          dataBadge={financeSSOT.badge}
        />

        <FinancePayoutAuditSection
          mondayPayouts={mondayPayouts}
          currencyCode={resolvedCurrency}
          onRetry={handleRetryPayout}
          retryingId={retryingPayoutId}
          compact={!selectedDriverId}
        />

        <div className="flex flex-wrap items-center gap-3">
          <ServiceAreaFinanceFilter value={serviceFilter} onChange={setServiceFilter} />
          {isMixedCurrency && (
            <Badge variant="outline" className="text-amber-600 border-amber-300">
              <AlertTriangle className="h-3 w-3 mr-1" />
              Mixed currencies — select a service area for SSOT totals
            </Badge>
          )}
        </div>

        <Tabs value={mainSection} onValueChange={(v) => setMainSection(v as MainSection)}>
          <TabsList>
            <TabsTrigger value="overview" className="gap-1.5">
              <Users className="h-4 w-4" />
              Drivers
            </TabsTrigger>
            <TabsTrigger value="ledger" className="gap-1.5">
              <BookOpen className="h-4 w-4" />
              Ledger audit
            </TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="space-y-6 mt-4">
            <div className="grid gap-4 md:grid-cols-3">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Ready for Payout</CardTitle>
                  <CheckCircle2 className="h-4 w-4 text-green-500" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{driversPayable}</div>
                  <p className="text-xs text-muted-foreground">Drivers with cleared summary balance</p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Owed to ONECAB</CardTitle>
                  <AlertTriangle className="h-4 w-4 text-red-500" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{driversInDebt}</div>
                  <p className="text-xs text-muted-foreground">Drivers owing cash trip commission</p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Negative Wallet</CardTitle>
                  <TrendingDown className="h-4 w-4 text-destructive" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">
                    {drivers.filter((d) => d.wallet_balance < 0).length}
                  </div>
                  <p className="text-xs text-muted-foreground">Ledger balance below zero</p>
                </CardContent>
              </Card>
            </div>

            <div className="space-y-4">
              <div className="flex flex-col sm:flex-row justify-between gap-4">
                <div className="flex flex-wrap gap-1">
                  {([
                    ['all', `All (${drivers.length})`],
                    ['payable', `Ready (${driversPayable})`],
                    ['in_debt', `In Debt (${driversInDebt})`],
                    ['positive', `Positive (${driversWithBalance})`],
                  ] as const).map(([key, label]) => (
                    <Button
                      key={key}
                      variant={driverFilter === key ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => setDriverFilter(key)}
                    >
                      {label}
                    </Button>
                  ))}
                </div>
                <div className="flex gap-2">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      placeholder="Search driver…"
                      className="pl-9 w-[220px]"
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                    />
                  </div>
                  <Button variant="outline" size="icon" onClick={() => refetch()}>
                    <RefreshCw className="h-4 w-4" />
                  </Button>
                </div>
              </div>

            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Driver</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Trips</TableHead>
                      <TableHead className="text-right">Card Credits</TableHead>
                      <TableHead className="text-right">Owed to ONECAB</TableHead>
                      <TableHead className="text-right">Wallet</TableHead>
                      <TableHead className="text-right">Ready</TableHead>
                      <TableHead className="text-right">In-flight</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredDrivers.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={9} className="text-center py-8 text-muted-foreground">
                          No drivers found
                        </TableCell>
                      </TableRow>
                    ) : (
                      filteredDrivers.map((d) => (
                        <TableRow key={d.driver_id}>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center">
                                <User className="h-4 w-4" />
                              </div>
                              <div>
                                <p className="font-medium">{d.first_name} {d.last_name}</p>
                                <p className="text-xs text-muted-foreground">{d.email}</p>
                              </div>
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge variant={d.is_online ? 'default' : 'secondary'} className={d.is_online ? 'bg-green-500' : ''}>
                              {d.is_online ? 'Online' : 'Offline'}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right">{d.completed_trips}</TableCell>
                          <TableCell className="text-right text-green-600">{dFmt(d, d.card_net_credits)}</TableCell>
                          <TableCell className="text-right text-red-500">
                            {d.amount_owed_to_onecab > 0 ? dFmt(d, d.amount_owed_to_onecab) : dFmt(d, 0)}
                          </TableCell>
                          <TableCell className={`text-right font-medium ${d.wallet_balance >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                            {dFmt(d, d.wallet_balance)}
                          </TableCell>
                          <TableCell className="text-right text-green-600">{dFmt(d, d.net_available_for_payout)}</TableCell>
                          <TableCell className="text-right">
                            {d.reserved_cashout_pence > 0 ? (
                              <Badge variant="outline" className="text-amber-600 border-amber-300">
                                {dFmt(d, d.reserved_cashout_pence)}
                              </Badge>
                            ) : (
                              <span className="text-muted-foreground text-xs">—</span>
                            )}
                          </TableCell>
                          <TableCell className="text-right">
                            <Button variant="ghost" size="sm" onClick={() => setSelectedDriverId(d.driver_id)}>
                              <Eye className="h-4 w-4" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
            </div>
          </TabsContent>

          <TabsContent value="ledger" className="mt-4">
            <FinanceLedgerPanel serviceFilter={serviceFilter} />
          </TabsContent>
        </Tabs>

        <Dialog open={!!selectedDriverId} onOpenChange={() => setSelectedDriverId(null)}>
          <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col p-0 gap-0">
            <DialogHeader className="p-6 pb-3 border-b shrink-0">
              <DialogTitle>Driver wallet & settlement</DialogTitle>
              <DialogDescription>
                {selectedDriverDetail?.first_name} {selectedDriverDetail?.last_name} — {selectedDriverDetail?.email}
              </DialogDescription>
            </DialogHeader>
            {selectedDriverDetail ? (
              <div className="space-y-4 overflow-y-auto px-6 py-4 flex-1 min-h-0">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <Card>
                    <CardContent className="pt-4">
                      <p className="text-xs text-muted-foreground">Wallet (ledger)</p>
                      <p className={`text-lg font-bold ${selectedDriverDetail.wallet_balance >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {formatPence(selectedDriverDetail.wallet_balance, selectedDriverDetail.currency_code)}
                      </p>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="pt-4">
                      <p className="text-xs text-muted-foreground">Ready for payout</p>
                      <p className="text-lg font-bold text-green-600">
                        {formatPence(driverPayoutGate.payoutAmountPence, selectedDriverDetail.currency_code)}
                      </p>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="pt-4">
                      <p className="text-xs text-muted-foreground">Owed to ONECAB</p>
                      <p className={`text-lg font-bold ${selectedDriverDetail.amount_owed_to_onecab > 0 ? 'text-red-600' : 'text-muted-foreground'}`}>
                        {formatPence(selectedDriverDetail.amount_owed_to_onecab, selectedDriverDetail.currency_code)}
                      </p>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="pt-4">
                      <p className="text-xs text-muted-foreground">Today&apos;s trip gross (calendar day)</p>
                      <p className="text-lg font-bold">{formatPence(selectedDriverDetail.today_gross_earnings, selectedDriverDetail.currency_code)}</p>
                    </CardContent>
                  </Card>
                </div>

                <DriverSSOTPayoutPanel
                  driverId={selectedDriverId}
                  currencyCode={selectedDriverDetail.currency_code}
                  filter={serviceFilter}
                  compact
                  inFlightPayout={!!inFlightPayout}
                  driverSummary={{
                    stripe_account_id: selectedDriverDetail.stripe_account_id,
                    onboarding_complete: selectedDriverDetail.onboarding_complete,
                    payouts_enabled: selectedDriverDetail.payouts_enabled,
                    amount_owed_to_onecab: selectedDriverDetail.amount_owed_to_onecab,
                    card_net_credits: selectedDriverDetail.card_net_credits,
                  }}
                />

                <Card>
                  <CardContent className="pt-4 space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground flex items-center gap-1"><CreditCard className="h-3 w-3" /> Card credits</span>
                      <span className="text-green-600">+{formatPence(selectedDriverDetail.card_net_credits, selectedDriverDetail.currency_code)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground flex items-center gap-1"><Banknote className="h-3 w-3" /> Cash commission</span>
                      <span className="text-red-600">-{formatPence(selectedDriverDetail.cash_commission_debits, selectedDriverDetail.currency_code)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Payouts sent</span>
                      <span className="text-blue-600">-{formatPence(selectedDriverDetail.total_payouts_sent, selectedDriverDetail.currency_code)}</span>
                    </div>
                    {selectedDriverDetail.adjustments_total !== 0 && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Adjustments</span>
                        <span className={selectedDriverDetail.adjustments_total >= 0 ? 'text-green-600' : 'text-red-600'}>
                          {selectedDriverDetail.adjustments_total >= 0 ? '+' : ''}
                          {formatPence(selectedDriverDetail.adjustments_total, selectedDriverDetail.currency_code)}
                        </span>
                      </div>
                    )}
                    <Separator />
                    <div className="flex justify-between font-medium">
                      <span>= Wallet balance</span>
                      <span className={selectedDriverDetail.wallet_balance >= 0 ? 'text-green-600' : 'text-red-600'}>
                        {formatPence(selectedDriverDetail.wallet_balance, selectedDriverDetail.currency_code)}
                      </span>
                    </div>
                  </CardContent>
                </Card>

                <div className="grid grid-cols-2 gap-3">
                  <Card>
                    <CardContent className="pt-4">
                      <p className="text-xs text-muted-foreground mb-2">Cash trips ({selectedDriverDetail.cash_trip_count})</p>
                      <div className="space-y-1 text-sm">
                        <div className="flex justify-between"><span>Gross</span><span>{formatPence(selectedDriverDetail.cash_gross_total, selectedDriverDetail.currency_code)}</span></div>
                        <div className="flex justify-between"><span>Commission</span><span className="text-red-500">-{formatPence(selectedDriverDetail.cash_commission_debits, selectedDriverDetail.currency_code)}</span></div>
                      </div>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="pt-4">
                      <p className="text-xs text-muted-foreground mb-2">Card trips ({selectedDriverDetail.card_trip_count})</p>
                      <div className="space-y-1 text-sm">
                        <div className="flex justify-between"><span>Net credits</span><span className="text-green-600">+{formatPence(selectedDriverDetail.card_net_credits, selectedDriverDetail.currency_code)}</span></div>
                        <div className="flex justify-between"><span>Commission</span><span className="text-red-500">-{formatPence(selectedDriverDetail.card_commission_total, selectedDriverDetail.currency_code)}</span></div>
                      </div>
                    </CardContent>
                  </Card>
                </div>

                <div>
                  <h4 className="font-medium mb-2">Payout diagnostics</h4>
                  <MondayPayoutDiagnosticsTable
                    rows={mondayPayouts.data?.payouts ?? []}
                    currencyCode={selectedDriverDetail.currency_code}
                    compact
                    emptyMessage="No payout records for this driver."
                  />
                </div>

                <Separator />

                <div>
                  <h4 className="font-medium mb-2">Driver ledger (recent)</h4>
                  <ScrollArea className="h-[200px]">
                    {isLoadingLedger ? (
                      <div className="flex items-center justify-center py-8">
                        <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
                      </div>
                    ) : ledgerEntries.length === 0 ? (
                      <p className="text-center text-muted-foreground py-8">No ledger entries</p>
                    ) : (
                      <div className="space-y-2">
                        {ledgerEntries.map((entry) => {
                          const { label, color } = getEntryTypeDisplay(entry.entry_type);
                          const isPositive = entry.amount_pence > 0;
                          return (
                            <div key={entry.id} className="flex items-center justify-between p-3 rounded-lg border">
                              <div className="flex items-center gap-3">
                                <div className={`h-8 w-8 rounded-full flex items-center justify-center ${isPositive ? 'bg-green-100' : 'bg-red-100'}`}>
                                  {isPositive ? (
                                    <ArrowDownRight className="h-4 w-4 text-green-600" />
                                  ) : (
                                    <ArrowUpRight className="h-4 w-4 text-red-600" />
                                  )}
                                </div>
                                <div>
                                  <p className={`font-medium text-sm ${color}`}>{label}</p>
                                  <p className="text-xs text-muted-foreground">{format(new Date(entry.created_at), 'dd MMM yyyy, HH:mm')}</p>
                                </div>
                              </div>
                              <div className="text-right">
                                <p className={`font-bold text-sm ${isPositive ? 'text-green-600' : 'text-red-600'}`}>
                                  {isPositive ? '+' : ''}{formatPence(entry.amount_pence, entry.currency_code || selectedDriverDetail.currency_code)}
                                </p>
                                {entry.description && (
                                  <p className="text-xs text-muted-foreground max-w-[180px] truncate">{entry.description}</p>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </ScrollArea>
                  <p className="text-xs text-muted-foreground mt-2">
                    For all drivers and recovery debits, use the Ledger audit tab.
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-center py-8">
                <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            )}
            <DialogFooter className="p-4 border-t shrink-0 gap-2 flex-wrap">
              <Button variant="outline" size="sm" onClick={() => { setAdjustmentType('add'); setShowAdjustmentDialog(true); }}>
                <Plus className="h-4 w-4 mr-1" />
                Adjustment
              </Button>
              {selectedDriverDetail && driverPayoutGate.canPayout ? (
                <Button
                  size="sm"
                  variant={driverPayoutGate.softWarningMessage ? 'outline' : 'default'}
                  className={driverPayoutGate.softWarningMessage ? 'border-amber-400 text-amber-900' : ''}
                  onClick={() => setShowPayoutConfirm(true)}
                  disabled={payoutMutation.isPending || driverPayoutGate.isLoading}
                >
                  <Wallet className="h-4 w-4 mr-1" />
                  Pay driver {formatPence(driverPayoutGate.payoutAmountPence, selectedDriverDetail.currency_code)}
                </Button>
              ) : selectedDriverDetail && driverPayoutGate.ssot ? (
                <Button size="sm" variant="secondary" disabled title={driverPayoutGate.blockedHeadline ?? MANUAL_PAYOUT_NO_SSOT_BALANCE_MESSAGE}>
                  <Wallet className="h-4 w-4 mr-1" />
                  Pay driver — blocked
                </Button>
              ) : null}
              <Button variant="outline" onClick={() => setSelectedDriverId(null)}>Close</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {selectedDriverDetail && driverPayoutGate.ssot && selectedDriverId && (
          <ManualPayoutConfirmDialog
            open={showPayoutConfirm}
            onOpenChange={setShowPayoutConfirm}
            driver={{
              id: selectedDriverId,
              first_name: selectedDriverDetail.first_name,
              last_name: selectedDriverDetail.last_name,
              currency_code: selectedDriverDetail.currency_code,
              wallet_balance: selectedDriverDetail.wallet_balance,
            }}
            ssot={driverPayoutGate.ssot}
            isPending={payoutMutation.isPending}
            onConfirm={() => payoutMutation.mutate(selectedDriverId)}
          />
        )}

        <Dialog open={showAdjustmentDialog} onOpenChange={setShowAdjustmentDialog}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Wallet adjustment</DialogTitle>
              <DialogDescription>Add a manual credit or debit to the driver wallet</DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="flex gap-2">
                <Button variant={adjustmentType === 'add' ? 'default' : 'outline'} size="sm" onClick={() => setAdjustmentType('add')}>
                  <Plus className="h-4 w-4 mr-1" />Credit
                </Button>
                <Button variant={adjustmentType === 'deduct' ? 'destructive' : 'outline'} size="sm" onClick={() => setAdjustmentType('deduct')}>
                  <Minus className="h-4 w-4 mr-1" />Debit
                </Button>
              </div>
              <div>
                <Label>Amount ({getCurrencySymbol(selectedDriverDetail?.currency_code || '')})</Label>
                <Input type="number" step="0.01" placeholder="0.00" value={adjustmentAmount} onChange={(e) => setAdjustmentAmount(e.target.value)} />
              </div>
              <div>
                <Label>Reason</Label>
                <Textarea placeholder="Reason for adjustment…" value={adjustmentReason} onChange={(e) => setAdjustmentReason(e.target.value)} />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowAdjustmentDialog(false)}>Cancel</Button>
              <Button onClick={handleAddAdjustment} disabled={adjustmentMutation.isPending}>
                {adjustmentMutation.isPending ? 'Processing…' : 'Submit'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </AdminLayout>
  );
}
