import { useState, useMemo } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { 
  useDriverWallets, 
  useDriverLedger, 
  formatPence, 
  getEntryTypeDisplay,
  type DriverWalletData,
  type LedgerEntry
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
  const [selectedDriver, setSelectedDriver] = useState<DriverWalletData | null>(null);

  const { data: wallets = [], isLoading, refetch } = useDriverWallets();
  const { data: ledgerEntries = [], isLoading: isLoadingLedger } = useDriverLedger(selectedDriver?.driver_id || null);

  const filteredWallets = useMemo(() => {
    return wallets.filter(wallet => {
      const fullName = `${wallet.first_name} ${wallet.last_name}`.toLowerCase();
      const matchesSearch = 
        fullName.includes(searchTerm.toLowerCase()) ||
        wallet.email.toLowerCase().includes(searchTerm.toLowerCase());
      
      if (activeTab === 'in_debt') {
        return matchesSearch && wallet.available_pence < 0;
      }
      if (activeTab === 'positive') {
        return matchesSearch && wallet.available_pence > 0;
      }
      return matchesSearch;
    });
  }, [wallets, searchTerm, activeTab]);

  // Stats
  const totalBalance = wallets.reduce((sum, w) => sum + w.available_pence, 0);
  const totalDebt = wallets.reduce((sum, w) => sum + Math.abs(w.total_debt_pence), 0);
  const totalEarnings = wallets.reduce((sum, w) => sum + w.total_earnings_pence, 0);
  const driversInDebt = wallets.filter(w => w.available_pence < 0).length;
  const driversWithBalance = wallets.filter(w => w.available_pence > 0).length;

  const getBalanceBadge = (balance: number) => {
    if (balance < 0) {
      return <Badge variant="destructive" className="gap-1"><AlertTriangle className="h-3 w-3" /> Debt</Badge>;
    }
    if (balance > 0) {
      return <Badge variant="default" className="bg-green-500 gap-1"><CheckCircle2 className="h-3 w-3" /> Positive</Badge>;
    }
    return <Badge variant="secondary">Zero</Badge>;
  };

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
      description="Source of truth for driver financial balances — all entries are immutable ledger records"
    >
      <div className="space-y-6">
        {/* Stats */}
        <div className="grid gap-4 md:grid-cols-5">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Net Balance</CardTitle>
              <Wallet className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className={`text-2xl font-bold ${totalBalance >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                {formatPence(totalBalance)}
              </div>
              <p className="text-xs text-muted-foreground">All drivers combined</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Debt Owed</CardTitle>
              <TrendingDown className="h-4 w-4 text-red-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-red-500">{formatPence(totalDebt)}</div>
              <p className="text-xs text-muted-foreground">Cash commission owed</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Earnings</CardTitle>
              <TrendingUp className="h-4 w-4 text-green-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-500">{formatPence(totalEarnings)}</div>
              <p className="text-xs text-muted-foreground">Digital payments credited</p>
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
              <TabsTrigger value="all">All Drivers ({wallets.length})</TabsTrigger>
              <TabsTrigger value="in_debt">
                In Debt
                {driversInDebt > 0 && (
                  <Badge variant="destructive" className="ml-1 h-5 min-w-5 rounded-full p-0 flex items-center justify-center text-xs">
                    {driversInDebt}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="positive">Positive ({driversWithBalance})</TabsTrigger>
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
                      <TableHead className="text-right">Balance</TableHead>
                      <TableHead className="text-right">Total Debt</TableHead>
                      <TableHead className="text-right">Total Earnings</TableHead>
                      <TableHead className="text-right">Trips</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredWallets.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                          No drivers found
                        </TableCell>
                      </TableRow>
                    ) : (
                      filteredWallets.map((wallet) => (
                        <TableRow key={wallet.driver_id}>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center">
                                <User className="h-4 w-4" />
                              </div>
                              <div>
                                <p className="font-medium">{wallet.first_name} {wallet.last_name}</p>
                                <p className="text-xs text-muted-foreground">{wallet.email}</p>
                              </div>
                            </div>
                          </TableCell>
                          <TableCell>{getBalanceBadge(wallet.available_pence)}</TableCell>
                          <TableCell className={`text-right font-medium ${wallet.available_pence >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                            {formatPence(wallet.available_pence)}
                          </TableCell>
                          <TableCell className="text-right text-red-500">
                            {formatPence(Math.abs(wallet.total_debt_pence))}
                          </TableCell>
                          <TableCell className="text-right text-green-500">
                            {formatPence(wallet.total_earnings_pence)}
                          </TableCell>
                          <TableCell className="text-right">{wallet.trip_count}</TableCell>
                          <TableCell className="text-right">
                            <Button 
                              variant="ghost" 
                              size="sm"
                              onClick={() => setSelectedDriver(wallet)}
                            >
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

        {/* Driver Ledger Dialog */}
        <Dialog open={!!selectedDriver} onOpenChange={() => setSelectedDriver(null)}>
          <DialogContent className="max-w-2xl max-h-[80vh]">
            <DialogHeader>
              <DialogTitle>Wallet Ledger</DialogTitle>
              <DialogDescription>
                {selectedDriver?.first_name} {selectedDriver?.last_name} - Transaction History
              </DialogDescription>
            </DialogHeader>
            {selectedDriver && (
              <div className="space-y-4">
                {/* Balance Summary */}
                <div className="grid grid-cols-3 gap-4">
                  <Card>
                    <CardContent className="pt-4">
                      <p className="text-xs text-muted-foreground">Available Balance</p>
                      <p className={`text-xl font-bold ${selectedDriver.available_pence >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {formatPence(selectedDriver.available_pence)}
                      </p>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="pt-4">
                      <p className="text-xs text-muted-foreground">Cash Debt</p>
                      <p className="text-xl font-bold text-red-500">
                        {formatPence(Math.abs(selectedDriver.total_debt_pence))}
                      </p>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="pt-4">
                      <p className="text-xs text-muted-foreground">Digital Earnings</p>
                      <p className="text-xl font-bold text-green-500">
                        {formatPence(selectedDriver.total_earnings_pence)}
                      </p>
                    </CardContent>
                  </Card>
                </div>

                <Separator />

                {/* Ledger Entries */}
                <div>
                  <h4 className="font-medium mb-2">Transaction History</h4>
                  <ScrollArea className="h-[300px]">
                    {isLoadingLedger ? (
                      <div className="flex items-center justify-center py-8">
                        <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
                      </div>
                    ) : ledgerEntries.length === 0 ? (
                      <p className="text-center text-muted-foreground py-8">No transactions yet</p>
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
                                  <p className={`font-medium ${color}`}>{label}</p>
                                  <p className="text-xs text-muted-foreground">
                                    {format(new Date(entry.created_at), 'dd MMM yyyy, HH:mm')}
                                  </p>
                                </div>
                              </div>
                              <div className="text-right">
                                <p className={`font-bold ${isPositive ? 'text-green-600' : 'text-red-600'}`}>
                                  {isPositive ? '+' : ''}{formatPence(entry.amount_pence)}
                                </p>
                                {entry.description && (
                                  <p className="text-xs text-muted-foreground max-w-[200px] truncate">
                                    {entry.description}
                                  </p>
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
              <Button variant="outline" onClick={() => setSelectedDriver(null)}>
                Close
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </AdminLayout>
  );
}
