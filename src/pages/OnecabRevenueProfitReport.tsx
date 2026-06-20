import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { format, startOfWeek, startOfMonth, startOfQuarter, startOfYear, endOfDay, startOfDay } from 'date-fns';
import { supabase } from '@/integrations/supabase/client';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Info, Download, Printer, Plus, Trash2, Loader2, TrendingUp, TrendingDown, Receipt } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { formatPence } from '@/hooks/useDriverWallet';
import { useStaffProfile } from '@/hooks/useStaffProfile';

type PeriodMode = 'weekly' | 'monthly' | 'quarterly' | 'yearly' | 'custom';
type ExpenseCategory = 'technology' | 'marketing' | 'operations' | 'staff' | 'other';

const SUBCATEGORIES: Record<ExpenseCategory, string[]> = {
  technology: ['Stripe', 'Supabase', 'Google Maps', 'Firebase', 'Domains', 'Hosting'],
  marketing: ['Advertising', 'Flyers', 'Promotions'],
  operations: ['Insurance', 'Accountant', 'Phone', 'Internet', 'Office Costs'],
  staff: ['Director Salary', 'Admin Salary', 'Support Staff'],
  other: ['Custom Expense'],
};

const DEFAULT_CORP_TAX_PCT = 25;
const CORP_TAX_SETTING_KEY = 'corporation_tax_rate';

interface RegionRow { id: string; name: string; currency_code?: string | null }
interface ServiceAreaRow { id: string; name: string; region_id: string | null }
interface ExpenseRow {
  id: string;
  category: ExpenseCategory;
  subcategory: string;
  description: string | null;
  amount_pence: number;
  currency_code: string;
  region_id: string | null;
  service_area_id: string | null;
  expense_date: string;
  notes: string | null;
  created_at: string;
}

interface TripRow {
  id: string;
  completed_at: string | null;
  payment_method: string | null;
  status: string | null;
  currency_code: string | null;
  gross_fare_pence: number | null;
  final_fare_pence: number | null;
  final_customer_fare_pence: number | null;
  commission_pence: number | null;
  
  corporate_account_id: string | null;
  region_id: string | null;
  service_area_id: string | null;
}

function tripGross(t: TripRow): number {
  return t.gross_fare_pence ?? t.final_customer_fare_pence ?? t.final_fare_pence ?? 0;
}

function periodRange(mode: PeriodMode, customFrom?: string, customTo?: string): { start: Date; end: Date } {
  const now = new Date();
  const end = endOfDay(now);
  switch (mode) {
    case 'weekly': return { start: startOfWeek(now, { weekStartsOn: 1 }), end };
    case 'monthly': return { start: startOfMonth(now), end };
    case 'quarterly': return { start: startOfQuarter(now), end };
    case 'yearly': return { start: startOfYear(now), end };
    case 'custom':
      return {
        start: customFrom ? startOfDay(new Date(customFrom)) : startOfMonth(now),
        end: customTo ? endOfDay(new Date(customTo)) : end,
      };
  }
}

export default function OnecabRevenueProfitReport() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { staffProfile } = useStaffProfile();

  // Edit allowed for Super Admin & Finance Admin (admin/super_admin/finance_manager). Others view-only.
  const canEditTaxRate = !staffProfile
    || ['super_admin', 'admin', 'finance_manager'].includes(staffProfile.role);

  const [periodMode, setPeriodMode] = useState<PeriodMode>('monthly');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [regionId, setRegionId] = useState<string>('__all__');
  const [serviceAreaId, setServiceAreaId] = useState<string>('__all__');
  const [taxRateInput, setTaxRateInput] = useState<string>(String(DEFAULT_CORP_TAX_PCT));

  const range = useMemo(() => periodRange(periodMode, customFrom, customTo), [periodMode, customFrom, customTo]);
  const periodLabel = `${format(range.start, 'd MMM yyyy')} – ${format(range.end, 'd MMM yyyy')}`;

  const { data: regions = [] } = useQuery({
    queryKey: ['orp-regions'],
    queryFn: async () => {
      const { data, error } = await supabase.from('regions').select('id,name,currency_code').order('name');
      if (error) throw error;
      return (data ?? []) as RegionRow[];
    },
  });

  const { data: serviceAreas = [] } = useQuery({
    queryKey: ['orp-service-areas'],
    queryFn: async () => {
      const { data, error } = await supabase.from('service_areas').select('id,name,region_id').order('name');
      if (error) throw error;
      return (data ?? []) as ServiceAreaRow[];
    },
  });

  const filteredServiceAreas = useMemo(() => {
    if (regionId === '__all__') return serviceAreas;
    return serviceAreas.filter((s) => s.region_id === regionId);
  }, [serviceAreas, regionId]);

  // Trips for revenue
  const tripsQuery = useQuery({
    queryKey: ['orp-trips', range.start.toISOString(), range.end.toISOString(), regionId, serviceAreaId],
    queryFn: async () => {
      let q = supabase
        .from('trips')
        .select('id,completed_at,payment_method,status,currency_code,gross_fare_pence,final_fare_pence,final_customer_fare_pence,commission_pence,corporate_account_id,region_id,service_area_id')
        .eq('status', 'completed')
        .gte('completed_at', range.start.toISOString())
        .lte('completed_at', range.end.toISOString())
        .limit(10000);
      if (regionId !== '__all__') q = q.eq('region_id', regionId);
      if (serviceAreaId !== '__all__') q = q.eq('service_area_id', serviceAreaId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as TripRow[];
    },
  });

  // Expenses for the period
  const expensesQuery = useQuery({
    queryKey: ['orp-expenses', range.start.toISOString(), range.end.toISOString(), regionId],
    queryFn: async () => {
      let q = supabase
        .from('onecab_expenses')
        .select('*')
        .gte('expense_date', format(range.start, 'yyyy-MM-dd'))
        .lte('expense_date', format(range.end, 'yyyy-MM-dd'))
        .order('expense_date', { ascending: false })
        .limit(5000);
      if (regionId !== '__all__') q = q.eq('region_id', regionId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as ExpenseRow[];
    },
  });

  const revenue = useMemo(() => {
    const trips = tripsQuery.data ?? [];
    let totalBooking = 0, commission = 0, corporate = 0, cashCommission = 0, stripeFees = 0;
    for (const t of trips) {
      const g = tripGross(t);
      totalBooking += g;
      commission += t.commission_pence ?? 0;
      const pm = String(t.payment_method ?? '').toUpperCase();
      if (t.corporate_account_id) corporate += g;
      if (pm === 'CASH') cashCommission += t.commission_pence ?? 0;
    }
    const currency = trips.find((t) => t.currency_code)?.currency_code ?? 'GBP';
    return {
      totalBooking,
      commission,
      corporate,
      cashCommission,
      stripeFees,
      netRevenue: commission - stripeFees,
      currency,
    };
  }, [tripsQuery.data]);

  // Persisted manual Corporation Tax rate (percentage)
  const taxRateQuery = useQuery({
    queryKey: ['orp-corp-tax-rate'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('admin_settings')
        .select('setting_value')
        .eq('setting_key', CORP_TAX_SETTING_KEY)
        .maybeSingle();
      if (error) throw error;
      const raw = (data?.setting_value as any);
      const pct = typeof raw === 'number' ? raw : (raw?.percent ?? raw?.value ?? DEFAULT_CORP_TAX_PCT);
      const num = Number(pct);
      return isFinite(num) ? num : DEFAULT_CORP_TAX_PCT;
    },
  });

  const corpTaxPct = taxRateQuery.data ?? DEFAULT_CORP_TAX_PCT;

  // Sync input when persisted value loads / changes
  useEffect(() => { setTaxRateInput(String(corpTaxPct)); }, [corpTaxPct]);

  const saveTaxRate = useMutation({
    mutationFn: async (pct: number) => {
      if (!isFinite(pct) || pct < 0 || pct > 100) throw new Error('Enter a rate between 0 and 100');
      const { error } = await supabase
        .from('admin_settings')
        .upsert({ setting_key: CORP_TAX_SETTING_KEY, setting_value: pct as any }, { onConflict: 'setting_key' });
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: 'Corporation Tax rate updated' });
      qc.invalidateQueries({ queryKey: ['orp-corp-tax-rate'] });
    },
    onError: (e: any) => toast({ title: 'Failed', description: e.message, variant: 'destructive' }),
  });

  const expenseTotals = useMemo(() => {
    const ex = expensesQuery.data ?? [];
    const byCat: Record<ExpenseCategory, number> = { technology: 0, marketing: 0, operations: 0, staff: 0, other: 0 };
    let total = 0;
    for (const e of ex) {
      byCat[e.category] = (byCat[e.category] ?? 0) + e.amount_pence;
      total += e.amount_pence;
    }
    return { byCat, total };
  }, [expensesQuery.data]);

  const profit = useMemo(() => {
    const profitBeforeTax = revenue.netRevenue - expenseTotals.total;
    const rate = Math.max(0, Math.min(100, corpTaxPct)) / 100;
    const corpTax = Math.max(0, Math.round(profitBeforeTax * rate));
    return {
      profitBeforeTax,
      corpTax,
      profitAfterTax: profitBeforeTax - corpTax,
      retainedEarnings: profitBeforeTax - corpTax,
    };
  }, [revenue, expenseTotals, corpTaxPct]);

  // Expense dialog state
  const [openDialog, setOpenDialog] = useState(false);
  const [newCategory, setNewCategory] = useState<ExpenseCategory>('technology');
  const [newSub, setNewSub] = useState('Stripe');
  const [newAmount, setNewAmount] = useState('');
  const [newDate, setNewDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [newCurrency, setNewCurrency] = useState('GBP');
  const [newRegion, setNewRegion] = useState<string>('__none__');
  const [newDescription, setNewDescription] = useState('');
  const [customSub, setCustomSub] = useState('');

  const createExpense = useMutation({
    mutationFn: async () => {
      const amount = Math.round(parseFloat(newAmount) * 100);
      if (!isFinite(amount) || amount <= 0) throw new Error('Enter a valid amount');
      const subcategory = newCategory === 'other' ? (customSub || 'Custom Expense') : newSub;
      const { error } = await supabase.from('onecab_expenses').insert({
        category: newCategory,
        subcategory,
        description: newDescription || null,
        amount_pence: amount,
        currency_code: newCurrency,
        region_id: newRegion === '__none__' ? null : newRegion,
        expense_date: newDate,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: 'Expense added' });
      setOpenDialog(false);
      setNewAmount('');
      setNewDescription('');
      setCustomSub('');
      qc.invalidateQueries({ queryKey: ['orp-expenses'] });
    },
    onError: (e: any) => toast({ title: 'Failed', description: e.message, variant: 'destructive' }),
  });

  const deleteExpense = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('onecab_expenses').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: 'Expense deleted' });
      qc.invalidateQueries({ queryKey: ['orp-expenses'] });
    },
    onError: (e: any) => toast({ title: 'Failed', description: e.message, variant: 'destructive' }),
  });

  const handleCsvExport = () => {
    const c = revenue.currency;
    const rows: string[][] = [
      ['ONECAB Revenue & Profit Report'],
      ['Period', periodLabel],
      ['Region', regionId === '__all__' ? 'All Regions' : (regions.find(r => r.id === regionId)?.name ?? '')],
      [],
      ['Revenue', 'Amount'],
      ['Total Booking Value', (revenue.totalBooking / 100).toFixed(2)],
      ['ONECAB Commission Revenue', (revenue.commission / 100).toFixed(2)],
      ['Corporate Revenue', (revenue.corporate / 100).toFixed(2)],
      ['Cash Commission Revenue', (revenue.cashCommission / 100).toFixed(2)],
      ['Stripe Fees', (revenue.stripeFees / 100).toFixed(2)],
      ['Net Revenue', (revenue.netRevenue / 100).toFixed(2)],
      [],
      ['Expenses by Category', 'Amount'],
      ['Technology', (expenseTotals.byCat.technology / 100).toFixed(2)],
      ['Marketing', (expenseTotals.byCat.marketing / 100).toFixed(2)],
      ['Operations', (expenseTotals.byCat.operations / 100).toFixed(2)],
      ['Staff', (expenseTotals.byCat.staff / 100).toFixed(2)],
      ['Other', (expenseTotals.byCat.other / 100).toFixed(2)],
      ['Total Expenses', (expenseTotals.total / 100).toFixed(2)],
      [],
      ['Profit', 'Amount'],
      ['Profit Before Tax', (profit.profitBeforeTax / 100).toFixed(2)],
      [`Corporation Tax Rate (%)`, String(corpTaxPct)],
      [`Estimated Corporation Tax (${corpTaxPct}%)`, (profit.corpTax / 100).toFixed(2)],
      ['Profit After Tax', (profit.profitAfterTax / 100).toFixed(2)],
      ['Currency', c],
      [],
      ['Expense Detail'],
      ['Date', 'Category', 'Subcategory', 'Description', 'Amount', 'Currency'],
      ...(expensesQuery.data ?? []).map(e => [
        e.expense_date,
        e.category,
        e.subcategory,
        e.description ?? '',
        (e.amount_pence / 100).toFixed(2),
        e.currency_code,
      ]),
    ];
    const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `onecab-profit-report-${format(range.start, 'yyyyMMdd')}-${format(range.end, 'yyyyMMdd')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <AdminLayout
      title="ONECAB Revenue & Profit Report"
      description="Company revenue, expenses and profitability. Financial Reconciliation remains the SSOT for driver financials."
    >
      <div className="space-y-6">
        <Alert>
          <Info className="h-4 w-4" />
          <AlertTitle>Business reporting only</AlertTitle>
          <AlertDescription>
            This page is for company management and finance. It never modifies Financial Reconciliation, driver wallets,
            payouts, settlements or Stripe allocation.
          </AlertDescription>
        </Alert>

        {/* Filters */}
        <Card className="print:hidden">
          <CardHeader><CardTitle>Filters</CardTitle></CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div className="space-y-2">
                <Label>Period</Label>
                <Select value={periodMode} onValueChange={(v) => setPeriodMode(v as PeriodMode)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="weekly">Weekly</SelectItem>
                    <SelectItem value="monthly">Monthly</SelectItem>
                    <SelectItem value="quarterly">Quarterly</SelectItem>
                    <SelectItem value="yearly">Yearly</SelectItem>
                    <SelectItem value="custom">Custom</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Region</Label>
                <Select value={regionId} onValueChange={(v) => { setRegionId(v); setServiceAreaId('__all__'); }}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__all__">All Regions</SelectItem>
                    {regions.map((r) => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Service Area</Label>
                <Select value={serviceAreaId} onValueChange={setServiceAreaId}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__all__">All Service Areas</SelectItem>
                    {filteredServiceAreas.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              {periodMode === 'custom' && (
                <div className="space-y-2 md:col-span-1">
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label>From</Label>
                      <Input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
                    </div>
                    <div>
                      <Label>To</Label>
                      <Input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
                    </div>
                  </div>
                </div>
              )}
            </div>
            <div className="flex gap-2 mt-4">
              <Button variant="outline" onClick={handleCsvExport}>
                <Download className="h-4 w-4 mr-2" />Export CSV
              </Button>
              <Button variant="outline" onClick={() => window.print()}>
                <Printer className="h-4 w-4 mr-2" />Print / PDF
              </Button>
            </div>
            <p className="text-sm text-muted-foreground mt-3">Showing: {periodLabel}</p>
          </CardContent>
        </Card>

        {(tripsQuery.isFetching || expensesQuery.isFetching) && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        )}

        {/* Revenue Cards */}
        <div>
          <h2 className="text-lg font-semibold mb-3">Revenue</h2>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            <Stat icon={<Receipt />} label="Total Booking Value" value={formatPence(revenue.totalBooking, revenue.currency)} />
            <Stat icon={<TrendingUp />} label="ONECAB Commission" value={formatPence(revenue.commission, revenue.currency)} />
            <Stat label="Corporate Revenue" value={formatPence(revenue.corporate, revenue.currency)} />
            <Stat label="Cash Commission" value={formatPence(revenue.cashCommission, revenue.currency)} />
            <Stat label="Stripe Fees" value={formatPence(revenue.stripeFees, revenue.currency)} negative />
            <Stat label="Net Revenue" value={formatPence(revenue.netRevenue, revenue.currency)} highlight />
          </div>
        </div>

        {/* Expense Management */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle>Expense Management</CardTitle>
              <p className="text-sm text-muted-foreground mt-1">Total: {formatPence(expenseTotals.total, revenue.currency)}</p>
            </div>
            <Dialog open={openDialog} onOpenChange={setOpenDialog}>
              <DialogTrigger asChild>
                <Button><Plus className="h-4 w-4 mr-2" />Add Expense</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader><DialogTitle>New Expense</DialogTitle></DialogHeader>
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label>Category</Label>
                      <Select value={newCategory} onValueChange={(v) => { setNewCategory(v as ExpenseCategory); setNewSub(SUBCATEGORIES[v as ExpenseCategory][0]); }}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="technology">Technology</SelectItem>
                          <SelectItem value="marketing">Marketing</SelectItem>
                          <SelectItem value="operations">Operations</SelectItem>
                          <SelectItem value="staff">Staff</SelectItem>
                          <SelectItem value="other">Other</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label>Subcategory</Label>
                      {newCategory === 'other' ? (
                        <Input value={customSub} onChange={(e) => setCustomSub(e.target.value)} placeholder="Custom expense name" />
                      ) : (
                        <Select value={newSub} onValueChange={setNewSub}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {SUBCATEGORIES[newCategory].map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      )}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label>Amount</Label>
                      <Input type="number" step="0.01" value={newAmount} onChange={(e) => setNewAmount(e.target.value)} placeholder="0.00" />
                    </div>
                    <div>
                      <Label>Currency</Label>
                      <Select value={newCurrency} onValueChange={setNewCurrency}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="GBP">GBP</SelectItem>
                          <SelectItem value="EUR">EUR</SelectItem>
                          <SelectItem value="USD">USD</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label>Date</Label>
                      <Input type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} />
                    </div>
                    <div>
                      <Label>Region (optional)</Label>
                      <Select value={newRegion} onValueChange={setNewRegion}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">Company-wide</SelectItem>
                          {regions.map((r) => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div>
                    <Label>Description</Label>
                    <Textarea value={newDescription} onChange={(e) => setNewDescription(e.target.value)} placeholder="Optional notes" />
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setOpenDialog(false)}>Cancel</Button>
                  <Button onClick={() => createExpense.mutate()} disabled={createExpense.isPending}>
                    {createExpense.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                    Save Expense
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
              {(Object.keys(SUBCATEGORIES) as ExpenseCategory[]).map((cat) => (
                <div key={cat} className="rounded-md border p-3">
                  <div className="text-xs text-muted-foreground capitalize">{cat}</div>
                  <div className="font-semibold">{formatPence(expenseTotals.byCat[cat], revenue.currency)}</div>
                </div>
              ))}
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Subcategory</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(expensesQuery.data ?? []).length === 0 && (
                  <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground">No expenses in this period.</TableCell></TableRow>
                )}
                {(expensesQuery.data ?? []).map((e) => (
                  <TableRow key={e.id}>
                    <TableCell>{e.expense_date}</TableCell>
                    <TableCell><Badge variant="outline" className="capitalize">{e.category}</Badge></TableCell>
                    <TableCell>{e.subcategory}</TableCell>
                    <TableCell className="text-muted-foreground">{e.description ?? '—'}</TableCell>
                    <TableCell className="text-right">{formatPence(e.amount_pence, e.currency_code)}</TableCell>
                    <TableCell>
                      <Button size="sm" variant="ghost" onClick={() => deleteExpense.mutate(e.id)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* Profit & Tax */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <Card>
            <CardHeader><CardTitle>Profit Calculation</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Line label="ONECAB Commission Revenue" value={formatPence(revenue.commission, revenue.currency)} />
              <Line label="+ Corporate Revenue" value={formatPence(revenue.corporate, revenue.currency)} muted />
              <Line label="− Stripe Fees" value={formatPence(revenue.stripeFees, revenue.currency)} />
              <Line label="− Technology Costs" value={formatPence(expenseTotals.byCat.technology, revenue.currency)} />
              <Line label="− Marketing Costs" value={formatPence(expenseTotals.byCat.marketing, revenue.currency)} />
              <Line label="− Operating Costs" value={formatPence(expenseTotals.byCat.operations, revenue.currency)} />
              <Line label="− Staff Costs" value={formatPence(expenseTotals.byCat.staff, revenue.currency)} />
              <Line label="− Other Expenses" value={formatPence(expenseTotals.byCat.other, revenue.currency)} />
              <div className="border-t pt-2 mt-2 flex justify-between font-semibold">
                <span>Net Profit (Before Tax)</span>
                <span className={profit.profitBeforeTax >= 0 ? 'text-emerald-600' : 'text-destructive'}>
                  {formatPence(profit.profitBeforeTax, revenue.currency)}
                </span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Tax Overview</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Line label="Profit Before Tax" value={formatPence(profit.profitBeforeTax, revenue.currency)} />

              <div className="flex items-center justify-between gap-2 py-1">
                <Label htmlFor="corp-tax-rate" className="text-sm font-normal">
                  Corporation Tax Rate (%)
                </Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="corp-tax-rate"
                    type="number"
                    min={0}
                    max={100}
                    step="0.01"
                    value={taxRateInput}
                    onChange={(e) => setTaxRateInput(e.target.value)}
                    disabled={!canEditTaxRate || saveTaxRate.isPending}
                    className="w-24 h-8 text-right"
                  />
                  {canEditTaxRate && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={saveTaxRate.isPending || Number(taxRateInput) === corpTaxPct}
                      onClick={() => saveTaxRate.mutate(Number(taxRateInput))}
                    >
                      {saveTaxRate.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Save'}
                    </Button>
                  )}
                </div>
              </div>

              <Line
                label={`Estimated Corporation Tax (${corpTaxPct}%)`}
                value={formatPence(profit.corpTax, revenue.currency)}
              />
              <div className="border-t pt-2 mt-2 flex justify-between font-semibold">
                <span>Profit After Tax</span>
                <span className={profit.profitAfterTax >= 0 ? 'text-emerald-600' : 'text-destructive'}>
                  {formatPence(profit.profitAfterTax, revenue.currency)}
                </span>
              </div>
              <Line label="Retained Earnings" value={formatPence(profit.retainedEarnings, revenue.currency)} />
              <p className="text-xs text-muted-foreground pt-2">
                Estimate only for internal reporting — not the SSOT for HMRC filing.
                {!canEditTaxRate && ' You have view-only access to this rate.'}
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </AdminLayout>
  );
}

function Stat({ icon, label, value, negative, highlight }: { icon?: React.ReactNode; label: string; value: string; negative?: boolean; highlight?: boolean }) {
  return (
    <Card className={highlight ? 'border-primary' : ''}>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {icon && <span className="h-4 w-4">{icon}</span>}
          <span>{label}</span>
        </div>
        <div className={`text-xl font-semibold mt-1 ${negative ? 'text-destructive' : highlight ? 'text-primary' : ''}`}>
          {value}
        </div>
      </CardContent>
    </Card>
  );
}

function Line({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className={`flex justify-between ${muted ? 'text-muted-foreground' : ''}`}>
      <span>{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}
