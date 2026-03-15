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
import { 
  Search, 
  Download, 
  Wallet,
  TrendingUp,
  TrendingDown,
  Eye,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  User,
  Banknote,
  CreditCard,
  ArrowUpRight,
  ArrowDownRight
} from 'lucide-react';
import { format } from 'date-fns';

export default function DriverWallet() {
  const [activeTab, setActiveTab] = useState('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedDriver, setSelectedDriver] = useState<DriverFinancialSummary | null>(null);

  const { data: drivers = [], isLoading, refetch } = useDriverFinancialSummaries();
  const { data: ledgerEntries = [], isLoading: isLoadingLedger } = useDriverLedger(selectedDriver?.driver_id || null);

  const filteredDrivers = useMemo(() => {
    return drivers.filter(d => {
      const fullName = `${d.first_name} ${d.last_name}`.toLowerCase();
      const matchesSearch = 
        fullName.includes(searchTerm.toLowerCase()) ||
        d.email.toLowerCase().includes(searchTerm.toLowerCase());
      
      if (activeTab === 'in_debt') return matchesSearch && d.wallet_balance < 0;
      if (activeTab === 'positive') return matchesSearch && d.wallet_balance > 0;
      if (activeTab === 'online') return matchesSearch && d.is_online;
      return matchesSearch;
    });
  }, [drivers, searchTerm, activeTab]);

  // Aggregated stats from unified source
  const totalWalletBalance = drivers.reduce((sum, d) => sum + d.wallet_balance, 0);
  const totalCommissionOwed = drivers.reduce((sum, d) => sum + d.amount_owed_to_onecab, 0);
  const totalCardCredits = drivers.reduce((sum, d) => sum + d.card_net_credits, 0);
  const driversInDebt = drivers.filter(d => d.wallet_balance < 0).length;
  const driversWithBalance = drivers.filter(d => d.wallet_balance > 0).length;

  if (isLoading) {
    return (
      <AdminLayout title="Driver Wallet" description="Manage driver wallets and ledgers">
        <div className="flex items-center justify-center h-64">
          <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout 
      title="Driver Wallet & Ledger" 
      description="Unified financial view — wallet_balance = card_credits − cash_commission − payouts ± adjustments"
    >
      <div className="space-y-6">
        {/* Stats */}
        <div className="grid gap-4 md:grid-cols-5">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Net Wallet Balance</CardTitle>
              <Wallet className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className={`text-2xl font-bold ${totalWalletBalance >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                {formatPence(totalWalletBalance)}
              </div>
              <p className="text-xs text-muted-foreground">All drivers combined</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Commission Owed</CardTitle>
              <TrendingDown className="h-4 w-4 text-red-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-red-500">{formatPence(totalCommissionOwed)}</div>
              <p className="text-xs text-muted-foreground">Cash trip commission debt</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Card Credits</CardTitle>
              <CreditCard className="h-4 w-4 text-green-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-500">{formatPence(totalCardCredits)}</div>
              <p className="text-xs text-muted-foreground">Digital payment credits</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Drivers in Debt</CardTitle>
              <AlertTriangle className="h-4 w-4 text-red-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{driversInDebt}</div>
              <p className="text-xs text-muted-foreground">Owe commission</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Positive Balance</CardTitle>
              <CheckCircle2 className="h-4 w-4 text-green-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{driversWithBalance}</div>
              <p className="text-xs text-muted-foreground">Can request payout</p>
            </CardContent>
          </Card>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
          <div className="flex flex-col sm:flex-row justify-between gap-4">
            <TabsList>
              <TabsTrigger value="all">All ({drivers.length})</TabsTrigger>
              <TabsTrigger value="in_debt">
                In Debt
                {driversInDebt > 0 && (
                  <Badge variant="destructive" className="ml-1 h-5 min-w-5 rounded-full p-0 flex items-center justify-center text-xs">
                    {driversInDebt}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="positive">Positive ({driversWithBalance})</TabsTrigger>
              <TabsTrigger value="online">Online ({drivers.filter(d => d.is_online).length})</TabsTrigger>
            </TabsList>

            <div className="flex gap-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input 
                  placeholder="Search drivers..." 
                  className="pl-9 w-[200px]"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
              </div>
              <Button variant="outline" size="icon" onClick={() => refetch()}>
                <RefreshCw className="h-4 w-4" />
              </Button>
              <Button variant="outline">
                <Download className="h-4 w-4 mr-2" />
                Export
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
                      <TableHead className="text-right">Cash Commission</TableHead>
                      <TableHead className="text-right">Wallet Balance</TableHead>
                      <TableHead className="text-right">Trips</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredDrivers.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
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
                          <TableCell className="text-right">{formatPence(d.gross_trip_total)}</TableCell>
                          <TableCell className="text-right text-green-600">{formatPence(d.card_net_credits)}</TableCell>
                          <TableCell className="text-right text-red-500">
                            {d.cash_commission_debits > 0 ? `-${formatPence(d.cash_commission_debits)}` : formatPence(0)}
                          </TableCell>
                          <TableCell className={`text-right font-medium ${d.wallet_balance >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                            {formatPence(d.wallet_balance)}
                          </TableCell>
                          <TableCell className="text-right">{d.completed_trips}</TableCell>
                          <TableCell className="text-right">
                            <Button variant="ghost" size="sm" onClick={() => setSelectedDriver(d)}>
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
          </TabsContent>
        </Tabs>

        {/* Driver Detail Dialog */}
        <Dialog open={!!selectedDriver} onOpenChange={() => setSelectedDriver(null)}>
          <DialogContent className="max-w-2xl max-h-[80vh]">
            <DialogHeader>
              <DialogTitle>Wallet Details</DialogTitle>
              <DialogDescription>
                {selectedDriver?.first_name} {selectedDriver?.last_name} — Financial Summary
              </DialogDescription>
            </DialogHeader>
            {selectedDriver && (
              <div className="space-y-4">
                {/* Financial Summary Cards */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <Card>
                    <CardContent className="pt-4">
                      <p className="text-xs text-muted-foreground">Today's Earnings</p>
                      <p className="text-lg font-bold">{formatPence(selectedDriver.today_gross_earnings)}</p>
                      <div className="flex gap-2 mt-1">
                        <span className="text-xs text-muted-foreground flex items-center gap-0.5">
                          <Banknote className="h-3 w-3" /> {formatPence(selectedDriver.today_cash_earnings)}
                        </span>
                        <span className="text-xs text-muted-foreground flex items-center gap-0.5">
                          <CreditCard className="h-3 w-3" /> {formatPence(selectedDriver.today_card_earnings)}
                        </span>
                      </div>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="pt-4">
                      <p className="text-xs text-muted-foreground">Wallet Balance</p>
                      <p className={`text-lg font-bold ${selectedDriver.wallet_balance >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {formatPence(selectedDriver.wallet_balance)}
                      </p>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="pt-4">
                      <p className="text-xs text-muted-foreground">Available Payout</p>
                      <p className="text-lg font-bold text-green-600">{formatPence(selectedDriver.available_for_payout)}</p>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="pt-4">
                      <p className="text-xs text-muted-foreground">Owed to ONECAB</p>
                      <p className={`text-lg font-bold ${selectedDriver.amount_owed_to_onecab > 0 ? 'text-red-600' : 'text-muted-foreground'}`}>
                        {formatPence(selectedDriver.amount_owed_to_onecab)}
                      </p>
                    </CardContent>
                  </Card>
                </div>

                {/* Breakdown */}
                <Card>
                  <CardContent className="pt-4 space-y-2">
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Gross Trip Fares</span>
                      <span>{formatPence(selectedDriver.gross_trip_total)}</span>
                    </div>
                    <Separator />
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground flex items-center gap-1"><CreditCard className="h-3 w-3" /> Card Net Credits</span>
                      <span className="text-green-600">+{formatPence(selectedDriver.card_net_credits)}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground flex items-center gap-1"><Banknote className="h-3 w-3" /> Cash Commission Debits</span>
                      <span className="text-red-600">-{formatPence(selectedDriver.cash_commission_debits)}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Payouts Sent</span>
                      <span className="text-blue-600">-{formatPence(selectedDriver.total_payouts_sent)}</span>
                    </div>
                    {selectedDriver.adjustments_total !== 0 && (
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Adjustments</span>
                        <span className={selectedDriver.adjustments_total >= 0 ? 'text-green-600' : 'text-red-600'}>
                          {selectedDriver.adjustments_total >= 0 ? '+' : ''}{formatPence(selectedDriver.adjustments_total)}
                        </span>
                      </div>
                    )}
                    <Separator />
                    <div className="flex justify-between font-medium">
                      <span>Wallet Balance</span>
                      <span className={selectedDriver.wallet_balance >= 0 ? 'text-green-600' : 'text-red-600'}>
                        {formatPence(selectedDriver.wallet_balance)}
                      </span>
                    </div>
                  </CardContent>
                </Card>

                {/* Trip Breakdown */}
                <div className="grid grid-cols-2 gap-3">
                  <Card>
                    <CardContent className="pt-4">
                      <p className="text-xs text-muted-foreground mb-2">Cash Trips ({selectedDriver.cash_trip_count})</p>
                      <div className="space-y-1 text-sm">
                        <div className="flex justify-between"><span>Gross Fares</span><span>{formatPence(selectedDriver.cash_gross_total)}</span></div>
                        <div className="flex justify-between"><span>Commission Owed</span><span className="text-red-500">-{formatPence(selectedDriver.cash_commission_debits)}</span></div>
                        <div className="flex justify-between"><span>Driver Kept</span><span>{formatPence(selectedDriver.cash_net_earnings)}</span></div>
                      </div>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="pt-4">
                      <p className="text-xs text-muted-foreground mb-2">Card Trips ({selectedDriver.card_trip_count})</p>
                      <div className="space-y-1 text-sm">
                        <div className="flex justify-between"><span>Gross Fares</span><span>{formatPence(selectedDriver.card_gross_total)}</span></div>
                        <div className="flex justify-between"><span>Commission</span><span className="text-red-500">-{formatPence(selectedDriver.card_commission_total)}</span></div>
                        <div className="flex justify-between"><span>Wallet Credit</span><span className="text-green-600">+{formatPence(selectedDriver.card_net_credits)}</span></div>
                      </div>
                    </CardContent>
                  </Card>
                </div>

                <Separator />

                {/* Ledger Entries */}
                <div>
                  <h4 className="font-medium mb-2">Transaction History</h4>
                  <ScrollArea className="h-[200px]">
                    {isLoadingLedger ? (
                      <div className="flex items-center justify-center py-8">
                        <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
                      </div>
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
                                  {isPositive ? '+' : ''}{formatPence(entry.amount_pence)}
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
            <DialogFooter>
              <Button variant="outline" onClick={() => setSelectedDriver(null)}>Close</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </AdminLayout>
  );
}