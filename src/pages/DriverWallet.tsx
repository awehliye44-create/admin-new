import { useState, useMemo } from 'react';
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
import { 
  useDriverFinancialSummaries, 
  useDriverLedger, 
  formatPence, 
  getEntryTypeDisplay,
  type DriverFinancialSummary,
} from '@/hooks/useDriverWallet';
import { getCurrencySymbol } from '@/lib/regionSettings';
import { ServiceAreaFinanceFilter, DEFAULT_SERVICE_AREA_SELECTION, type ServiceAreaFinanceSelection } from '@/components/finance/ServiceAreaFinanceFilter';
import { CurrencyGroupedStats, getSingleCurrency } from '@/components/finance/CurrencyGroupedStats';
import { FinanceReconciliationTotalsCards } from '@/components/finance/FinanceReconciliationTotalsCards';
import { FinanceSSOT, useFinancialReconciliationSSOT } from '@/hooks/useFinancialReconciliationSSOT';
import { DriverSSOTPayoutPanel } from '@/components/finance/DriverSSOTPayoutPanel';
import { 
  Search, Wallet, TrendingDown, Eye, RefreshCw, AlertTriangle, CheckCircle2, User, Banknote, CreditCard, ArrowUpRight, ArrowDownRight
} from 'lucide-react';
import { format } from 'date-fns';

export default function DriverWallet() {
  const [activeTab, setActiveTab] = useState('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedDriver, setSelectedDriver] = useState<DriverFinancialSummary | null>(null);
  const [serviceFilter, setServiceFilter] = useState<ServiceAreaFinanceSelection>(DEFAULT_SERVICE_AREA_SELECTION);

  const financeSSOT = useFinancialReconciliationSSOT({ filter: serviceFilter });
  const { data: allDrivers = [], isLoading, refetch } = useDriverFinancialSummaries();
  const { data: ledgerEntries = [], isLoading: isLoadingLedger } = useDriverLedger(selectedDriver?.driver_id || null);

  // Filter by region when a service area is selected
  const drivers = useMemo(() => {
    if (!serviceFilter.regionId) return allDrivers;
    return allDrivers.filter(d => d.region_id === serviceFilter.regionId);
  }, [allDrivers, serviceFilter.regionId]);

  const filteredDrivers = useMemo(() => {
    return drivers.filter(d => {
      const fullName = `${d.first_name} ${d.last_name}`.toLowerCase();
      const matchesSearch = 
        fullName.includes(searchTerm.toLowerCase()) ||
        d.email.toLowerCase().includes(searchTerm.toLowerCase());
      
      if (activeTab === 'positive') return matchesSearch && d.wallet_balance > 0;
      if (activeTab === 'negative') return matchesSearch && d.wallet_balance < 0;
      if (activeTab === 'zero') return matchesSearch && d.wallet_balance === 0;
      return matchesSearch;
    });
  }, [drivers, searchTerm, activeTab]);

  // Resolved currency: from filter or single currency from data
  const resolvedCurrency = serviceFilter.currencyCode || getSingleCurrency(drivers) || '';
  const isMixedCurrency = !serviceFilter.currencyCode && !getSingleCurrency(drivers) && drivers.length > 0;

  const ssotSummary = financeSSOT.summary;
  const totalWalletBalance = ssotSummary
    ? FinanceSSOT.driverRemainingLiability(ssotSummary)
    : drivers.reduce((sum, d) => sum + d.wallet_balance, 0);
  const totalCommissionOwed = ssotSummary
    ? FinanceSSOT.onecabNetCommission(ssotSummary)
    : drivers.reduce((sum, d) => sum + d.amount_owed_to_onecab, 0);
  const totalCardCredits = drivers.reduce((sum, d) => sum + d.card_net_credits, 0);
  const driversInDebt = drivers.filter(d => d.wallet_balance < 0).length;
  const driversWithBalance = drivers.filter(d => d.wallet_balance > 0).length;

  // Per-driver currency formatter
  const dFmt = (d: DriverFinancialSummary, pence: number) => formatPence(pence, d.currency_code);

  if (isLoading) {
    return (
      <AdminLayout title="Driver Wallet" description="Manage driver wallets and ledgers">
        <div className="flex items-center justify-center h-64">
          <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </AdminLayout>
    );
  }

  // Selected driver's currency
  const sc = selectedDriver?.currency_code || '';
  const sFmt = (pence: number) => formatPence(pence, sc);

  return (
    <AdminLayout 
      title="Driver Wallet & Ledger" 
      description="Financial Reconciliation SSOT — official liability, commission, and payout totals"
    >
      <div className="space-y-6">
        <FinanceReconciliationTotalsCards ssot={financeSSOT} />

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
        <div className="grid gap-4 md:grid-cols-5">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Remaining Liability</CardTitle>
              <Wallet className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              {isMixedCurrency ? (
                <p className="text-sm text-muted-foreground">Select a service area for SSOT liability totals</p>
              ) : (
                <div className={`text-2xl font-bold ${totalWalletBalance >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                  {formatPence(totalWalletBalance, resolvedCurrency)}
                </div>
              )}
              <p className="text-xs text-muted-foreground">Financial Reconciliation SSOT — amount ONECAB still owes drivers</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">ONECAB Net Commission</CardTitle>
              <TrendingDown className="h-4 w-4 text-red-500" />
            </CardHeader>
            <CardContent>
              {isMixedCurrency ? (
                <p className="text-sm text-muted-foreground">Select a service area for SSOT commission totals</p>
              ) : (
                <div className="text-2xl font-bold text-red-500">{formatPence(totalCommissionOwed, resolvedCurrency)}</div>
              )}
              <p className="text-xs text-muted-foreground">Financial Reconciliation SSOT — after provider fees</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Card Credits</CardTitle>
              <CreditCard className="h-4 w-4 text-green-500" />
            </CardHeader>
            <CardContent>
              {isMixedCurrency ? (
                <CurrencyGroupedStats
                  items={drivers.map(d => ({ currency_code: d.currency_code, amount: d.card_net_credits }))}
                  className="text-lg font-bold text-green-500"
                />
              ) : (
                <div className="text-2xl font-bold text-green-500">{formatPence(totalCardCredits, resolvedCurrency)}</div>
              )}
              <p className="text-xs text-muted-foreground">Digital payment credits</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">In Debt</CardTitle>
              <AlertTriangle className="h-4 w-4 text-red-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{driversInDebt}</div>
              <p className="text-xs text-muted-foreground">Drivers with negative balance</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Payable</CardTitle>
              <CheckCircle2 className="h-4 w-4 text-green-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{driversWithBalance}</div>
              <p className="text-xs text-muted-foreground">Drivers with positive balance</p>
            </CardContent>
          </Card>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
          <div className="flex flex-col sm:flex-row justify-between gap-4">
            <TabsList>
              <TabsTrigger value="all">All Drivers ({drivers.length})</TabsTrigger>
              <TabsTrigger value="positive">Positive ({driversWithBalance})</TabsTrigger>
              <TabsTrigger value="negative">In Debt ({driversInDebt})</TabsTrigger>
            </TabsList>
            <div className="flex gap-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input placeholder="Search driver..." className="pl-9 w-[220px]" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
              </div>
              <Button variant="outline" size="icon" onClick={() => refetch()}>
                <RefreshCw className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <TabsContent value={activeTab} className="m-0">
            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Driver</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Gross Fares</TableHead>
                      <TableHead className="text-right">Card Credits</TableHead>
                      <TableHead className="text-right">Cash Debt</TableHead>
                      <TableHead className="text-right">Wallet</TableHead>
                      <TableHead className="text-right">In-flight cashout</TableHead>
                      <TableHead className="text-right">Trips</TableHead>
                      <TableHead></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredDrivers.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={9} className="text-center py-8 text-muted-foreground">No drivers found</TableCell>
                      </TableRow>
                    ) : (
                      filteredDrivers.map(d => (
                        <TableRow key={d.driver_id}>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center"><User className="h-4 w-4" /></div>
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
                          <TableCell className="text-right">{dFmt(d, d.gross_trip_total)}</TableCell>
                          <TableCell className="text-right text-green-600">{dFmt(d, d.card_net_credits)}</TableCell>
                          <TableCell className="text-right text-red-500">
                            {d.cash_commission_debits > 0 ? `-${dFmt(d, d.cash_commission_debits)}` : dFmt(d, 0)}
                          </TableCell>
                          <TableCell className={`text-right font-medium ${d.wallet_balance >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                            {dFmt(d, d.wallet_balance)}
                          </TableCell>
                          <TableCell className="text-right">
                            {d.reserved_cashout_pence > 0 ? (
                              <Badge variant="outline" className="text-amber-600 border-amber-300">
                                {dFmt(d, d.reserved_cashout_pence)} processing
                              </Badge>
                            ) : (
                              <span className="text-muted-foreground text-xs">—</span>
                            )}
                          </TableCell>
                          <TableCell className="text-right">{d.completed_trips}</TableCell>
                          <TableCell className="text-right">
                            <Button variant="ghost" size="sm" onClick={() => setSelectedDriver(d)}><Eye className="h-4 w-4" /></Button>
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

        {/* Driver Detail Dialog */}
        <Dialog open={!!selectedDriver} onOpenChange={() => setSelectedDriver(null)}>
          <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col p-0 gap-0">
            <DialogHeader className="p-6 pb-3 border-b shrink-0">
              <DialogTitle>Wallet Details</DialogTitle>
              <DialogDescription>
                {selectedDriver?.first_name} {selectedDriver?.last_name} — Financial Summary ({getCurrencySymbol(sc)} {sc || 'N/A'})
              </DialogDescription>
            </DialogHeader>
            {selectedDriver && (
              <div className="space-y-4 overflow-y-auto px-6 py-4 flex-1 min-h-0">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <Card><CardContent className="pt-4">
                    <p className="text-xs text-muted-foreground">Today's Earnings</p>
                    <p className="text-lg font-bold">{sFmt(selectedDriver.today_gross_earnings)}</p>
                    <div className="flex gap-2 mt-1">
                      <span className="text-xs text-muted-foreground flex items-center gap-0.5"><Banknote className="h-3 w-3" /> {sFmt(selectedDriver.today_cash_earnings)}</span>
                      <span className="text-xs text-muted-foreground flex items-center gap-0.5"><CreditCard className="h-3 w-3" /> {sFmt(selectedDriver.today_card_earnings)}</span>
                    </div>
                  </CardContent></Card>
                  <Card><CardContent className="pt-4">
                    <p className="text-xs text-muted-foreground">Wallet Balance</p>
                    <p className={`text-lg font-bold ${selectedDriver.wallet_balance >= 0 ? 'text-green-600' : 'text-red-600'}`}>{sFmt(selectedDriver.wallet_balance)}</p>
                  </CardContent></Card>
                  <Card><CardContent className="pt-4">
                    <p className="text-xs text-muted-foreground">Wallet (informational)</p>
                    <p className="text-lg font-bold text-muted-foreground">{sFmt(selectedDriver.wallet_balance)}</p>
                  </CardContent></Card>
                  <Card><CardContent className="pt-4">
                    <p className="text-xs text-muted-foreground">Owed to ONECAB</p>
                    <p className={`text-lg font-bold ${selectedDriver.amount_owed_to_onecab > 0 ? 'text-red-600' : 'text-muted-foreground'}`}>{sFmt(selectedDriver.amount_owed_to_onecab)}</p>
                  </CardContent></Card>
                </div>

                <DriverSSOTPayoutPanel
                  driverId={selectedDriver.driver_id}
                  currencyCode={selectedDriver.currency_code}
                  filter={serviceFilter}
                  compact
                />

                <Card>
                  <CardContent className="pt-4 space-y-2">
                    <div className="flex justify-between text-sm"><span className="text-muted-foreground">Gross Trip Fares</span><span>{sFmt(selectedDriver.gross_trip_total)}</span></div>
                    <Separator />
                    <div className="flex justify-between text-sm"><span className="text-muted-foreground flex items-center gap-1"><CreditCard className="h-3 w-3" /> Card Net Credits</span><span className="text-green-600">+{sFmt(selectedDriver.card_net_credits)}</span></div>
                    <div className="flex justify-between text-sm"><span className="text-muted-foreground flex items-center gap-1"><Banknote className="h-3 w-3" /> Cash Commission Debits</span><span className="text-red-600">-{sFmt(selectedDriver.cash_commission_debits)}</span></div>
                    <div className="flex justify-between text-sm"><span className="text-muted-foreground">Payouts Sent</span><span className="text-blue-600">-{sFmt(selectedDriver.total_payouts_sent)}</span></div>
                    {selectedDriver.adjustments_total !== 0 && (
                      <div className="flex justify-between text-sm"><span className="text-muted-foreground">Adjustments</span><span className={selectedDriver.adjustments_total >= 0 ? 'text-green-600' : 'text-red-600'}>{selectedDriver.adjustments_total >= 0 ? '+' : ''}{sFmt(selectedDriver.adjustments_total)}</span></div>
                    )}
                    <Separator />
                    <div className="flex justify-between font-medium"><span>Wallet Balance</span><span className={selectedDriver.wallet_balance >= 0 ? 'text-green-600' : 'text-red-600'}>{sFmt(selectedDriver.wallet_balance)}</span></div>
                  </CardContent>
                </Card>

                <div className="grid grid-cols-2 gap-3">
                  <Card><CardContent className="pt-4">
                    <p className="text-xs text-muted-foreground mb-2">Cash Trips ({selectedDriver.cash_trip_count})</p>
                    <div className="space-y-1 text-sm">
                      <div className="flex justify-between"><span>Gross Fares</span><span>{sFmt(selectedDriver.cash_gross_total)}</span></div>
                      <div className="flex justify-between"><span>Commission Owed</span><span className="text-red-500">-{sFmt(selectedDriver.cash_commission_debits)}</span></div>
                      <div className="flex justify-between"><span>Driver Kept</span><span>{sFmt(selectedDriver.cash_net_earnings)}</span></div>
                    </div>
                  </CardContent></Card>
                  <Card><CardContent className="pt-4">
                    <p className="text-xs text-muted-foreground mb-2">Card Trips ({selectedDriver.card_trip_count})</p>
                    <div className="space-y-1 text-sm">
                      <div className="flex justify-between"><span>Gross Fares</span><span>{sFmt(selectedDriver.card_gross_total)}</span></div>
                      <div className="flex justify-between"><span>Commission</span><span className="text-red-500">-{sFmt(selectedDriver.card_commission_total)}</span></div>
                      <div className="flex justify-between"><span>Wallet Credit</span><span className="text-green-600">+{sFmt(selectedDriver.card_net_credits)}</span></div>
                    </div>
                  </CardContent></Card>
                </div>

                <Separator />

                <div>
                  <h4 className="font-medium mb-2">Transaction History</h4>
                  <ScrollArea className="h-[200px]">
                    {isLoadingLedger ? (
                      <div className="flex items-center justify-center py-8"><RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" /></div>
                    ) : ledgerEntries.length === 0 ? (
                      <p className="text-center text-muted-foreground py-8">No ledger transactions yet</p>
                    ) : (
                      <div className="space-y-2">
                        {ledgerEntries.map((entry) => {
                          const { label, color } = getEntryTypeDisplay(entry.entry_type);
                          const isPositive = entry.amount_pence > 0;
                          return (
                            <div key={entry.id} className="flex items-center justify-between p-3 rounded-lg border">
                              <div className="flex items-center gap-3">
                                <div className={`h-8 w-8 rounded-full flex items-center justify-center ${isPositive ? 'bg-green-100' : 'bg-red-100'}`}>
                                  {isPositive ? <ArrowDownRight className="h-4 w-4 text-green-600" /> : <ArrowUpRight className="h-4 w-4 text-red-600" />}
                                </div>
                                <div>
                                  <p className={`font-medium ${color}`}>{label}</p>
                                  <p className="text-xs text-muted-foreground">{format(new Date(entry.created_at), 'dd MMM yyyy, HH:mm')}</p>
                                </div>
                              </div>
                              <div className="text-right">
                                <p className={`font-bold ${isPositive ? 'text-green-600' : 'text-red-600'}`}>
                                  {isPositive ? '+' : ''}{formatPence(entry.amount_pence, entry.currency_code)}
                                </p>
                                {entry.description && (
                                  <p className="text-xs text-muted-foreground max-w-[200px] truncate">{entry.description}</p>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </ScrollArea>
                </div>
              </div>
            )}
            <DialogFooter className="p-4 border-t shrink-0">
              <Button variant="outline" onClick={() => setSelectedDriver(null)}>Close</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </AdminLayout>
  );
}
