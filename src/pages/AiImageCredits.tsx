import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  MoreHorizontal, Plus, Coins, Package, History, Settings as SettingsIcon,
  Pencil, Trash2, ImageIcon, CreditCard, Ban, ShieldCheck, TrendingUp, Users,
} from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { useServiceAreas } from '@/hooks/useServiceAreas';

type Settings = {
  free_credits_for_new_merchants: number;
  credit_cost_per_image: number;
  credit_cost_per_regeneration: number;
  ai_generation_enabled: boolean;
  credit_purchase_enabled: boolean;
};
type Pkg = {
  id: string;
  name: string;
  credits: number;
  price: number;
  currency: string;
  active: boolean;
  sort_order: number;
};
type Balance = {
  merchant_id: string;
  business_name: string;
  category: string;
  service_area_id: string;
  status: string;
  ai_access_suspended: boolean;
  credits_remaining: number;
  free_ai_credits_granted: boolean;
  total_purchased: number;
  total_used: number;
  total_purchased_amount: number;
  currency: string;
};
type HistoryRow = {
  id: string;
  merchant_id: string;
  action_type: string;
  credits_changed: number;
  balance_after: number;
  admin_user_id: string | null;
  stripe_payment_id: string | null;
  package_id: string | null;
  notes: string | null;
  created_at: string;
  merchants?: { business_name: string; category: string; service_area_id: string } | null;
};
type Generation = {
  id: string;
  merchant_id: string;
  product_id: string | null;
  prompt: string;
  image_url: string | null;
  status: string;
  created_at: string;
  merchants?: { business_name: string; service_area_id: string } | null;
  merchant_products?: { name: string } | null;
};

const ACTION_LABEL: Record<string, string> = {
  free_grant: 'Free Grant',
  purchase: 'Purchase',
  generation_used: 'Generation Used',
  regeneration_used: 'Regeneration Used',
  manual_adjustment: 'Manual Adjustment',
  refund: 'Refund',
};

const MERCHANT_TYPES = ['food', 'grocery', 'retail', 'pharmacy', 'parcel'];

export default function AiImageCredits() {
  const { data: serviceAreas } = useServiceAreas();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [packages, setPackages] = useState<Pkg[]>([]);
  const [balances, setBalances] = useState<Balance[]>([]);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [generations, setGenerations] = useState<Generation[]>([]);
  const [pkgDialog, setPkgDialog] = useState<Pkg | null>(null);
  const [pkgIsNew, setPkgIsNew] = useState(false);
  const [adjustDialog, setAdjustDialog] = useState<Balance | null>(null);
  const [adjustDelta, setAdjustDelta] = useState('');
  const [adjustNotes, setAdjustNotes] = useState('');

  // Filters
  const [fServiceArea, setFServiceArea] = useState<string>('all');
  const [fType, setFType] = useState<string>('all');
  const [fMerchant, setFMerchant] = useState<string>('all');
  const [fFrom, setFFrom] = useState<string>('');
  const [fTo, setFTo] = useState<string>('');

  const loadAll = async () => {
    const [s, p, m, h, g] = await Promise.all([
      supabase.from('ai_credit_settings').select('*').eq('id', true).maybeSingle(),
      supabase.from('ai_credit_packages').select('*').order('sort_order'),
      supabase.from('merchants').select('id,business_name,category,service_area_id,status,free_ai_credits_granted,ai_access_suspended'),
      supabase.from('merchant_ai_credit_history').select('*, merchants(business_name,category,service_area_id)').order('created_at', { ascending: false }).limit(500),
      supabase.from('merchant_ai_generations').select('*, merchants(business_name,service_area_id), merchant_products(name)').order('created_at', { ascending: false }).limit(500),
    ]);
    if (s.data) setSettings(s.data as any);
    if (p.data) setPackages(p.data as any);
    if (h.data) setHistory(h.data as any);
    if (g.data) setGenerations(g.data as any);

    const merchantIds = (m.data ?? []).map((x: any) => x.id);
    const [credits, agg] = await Promise.all([
      supabase.from('merchant_ai_credits').select('merchant_id,credits_remaining').in('merchant_id', merchantIds),
      supabase.from('merchant_ai_credit_history').select('merchant_id,action_type,credits_changed,package_id').in('merchant_id', merchantIds),
    ]);
    const pkgMap = new Map<string, Pkg>((p.data ?? []).map((x: any) => [x.id, x]));
    const credMap = new Map<string, number>();
    (credits.data ?? []).forEach((r: any) => credMap.set(r.merchant_id, r.credits_remaining));
    const purchased = new Map<string, number>();
    const purchasedAmount = new Map<string, number>();
    const purchasedCurrency = new Map<string, string>();
    const used = new Map<string, number>();
    (agg.data ?? []).forEach((r: any) => {
      if (r.action_type === 'purchase') {
        purchased.set(r.merchant_id, (purchased.get(r.merchant_id) ?? 0) + r.credits_changed);
        const pkg = r.package_id ? pkgMap.get(r.package_id) : null;
        if (pkg) {
          purchasedAmount.set(r.merchant_id, (purchasedAmount.get(r.merchant_id) ?? 0) + Number(pkg.price));
          purchasedCurrency.set(r.merchant_id, pkg.currency);
        }
      }
      if (r.action_type === 'generation_used' || r.action_type === 'regeneration_used') {
        used.set(r.merchant_id, (used.get(r.merchant_id) ?? 0) + Math.abs(r.credits_changed));
      }
    });
    setBalances((m.data ?? []).map((row: any) => ({
      merchant_id: row.id,
      business_name: row.business_name,
      category: row.category,
      service_area_id: row.service_area_id,
      status: row.status,
      ai_access_suspended: !!row.ai_access_suspended,
      credits_remaining: credMap.get(row.id) ?? 0,
      free_ai_credits_granted: row.free_ai_credits_granted,
      total_purchased: purchased.get(row.id) ?? 0,
      total_used: used.get(row.id) ?? 0,
      total_purchased_amount: purchasedAmount.get(row.id) ?? 0,
      currency: purchasedCurrency.get(row.id) ?? 'GBP',
    })));
  };

  useEffect(() => { loadAll(); }, []);

  const saName = (id: string) => serviceAreas?.find((s) => s.id === id)?.name ?? '—';

  // ---- Filtering helpers ----
  const merchantPassesFilter = (b: { service_area_id: string; category: string; merchant_id: string }) => {
    if (fServiceArea !== 'all' && b.service_area_id !== fServiceArea) return false;
    if (fType !== 'all' && b.category !== fType) return false;
    if (fMerchant !== 'all' && b.merchant_id !== fMerchant) return false;
    return true;
  };
  const datePassesFilter = (iso: string) => {
    if (fFrom && iso < new Date(fFrom).toISOString()) return false;
    if (fTo) {
      const end = new Date(fTo); end.setDate(end.getDate() + 1);
      if (iso >= end.toISOString()) return false;
    }
    return true;
  };

  const filteredBalances = useMemo(() => balances.filter(merchantPassesFilter),
    [balances, fServiceArea, fType, fMerchant]);

  const filteredHistory = useMemo(() => history.filter((h) => {
    const m = h.merchants;
    if (!m) return fMerchant === 'all' && fServiceArea === 'all' && fType === 'all';
    return merchantPassesFilter({ service_area_id: m.service_area_id, category: m.category, merchant_id: h.merchant_id })
      && datePassesFilter(h.created_at);
  }), [history, fServiceArea, fType, fMerchant, fFrom, fTo]);

  const filteredGenerations = useMemo(() => generations.filter((g) => {
    const merch = balances.find((b) => b.merchant_id === g.merchant_id);
    if (!merch) return false;
    return merchantPassesFilter({ service_area_id: merch.service_area_id, category: merch.category, merchant_id: g.merchant_id })
      && datePassesFilter(g.created_at);
  }), [generations, balances, fServiceArea, fType, fMerchant, fFrom, fTo]);

  // ---- Stat cards ----
  const stats = useMemo(() => {
    let issued = 0, used = 0, purchased = 0, revenue = 0;
    let currency = 'GBP';
    for (const h of filteredHistory) {
      if (h.action_type === 'free_grant' || (h.action_type === 'manual_adjustment' && h.credits_changed > 0)) {
        issued += h.credits_changed;
      }
      if (h.action_type === 'generation_used' || h.action_type === 'regeneration_used') used += Math.abs(h.credits_changed);
      if (h.action_type === 'purchase') {
        purchased += h.credits_changed;
        const pkg = packages.find((p) => p.id === h.package_id);
        if (pkg) { revenue += Number(pkg.price); currency = pkg.currency; }
      }
    }
    return { issued, used, purchased, revenue, currency };
  }, [filteredHistory, packages]);

  // ---- Mutations ----
  const saveSettings = async () => {
    if (!settings) return;
    const { error } = await supabase.from('ai_credit_settings').update(settings).eq('id', true);
    if (error) return toast({ title: 'Failed', description: error.message, variant: 'destructive' });
    toast({ title: 'Settings saved' });
  };

  const savePackage = async () => {
    if (!pkgDialog) return;
    const payload = {
      name: pkgDialog.name,
      credits: Number(pkgDialog.credits),
      price: Number(pkgDialog.price),
      currency: pkgDialog.currency,
      active: pkgDialog.active,
      sort_order: pkgDialog.sort_order,
    };
    const op = pkgIsNew
      ? supabase.from('ai_credit_packages').insert(payload)
      : supabase.from('ai_credit_packages').update(payload).eq('id', pkgDialog.id);
    const { error } = await op;
    if (error) return toast({ title: 'Failed', description: error.message, variant: 'destructive' });
    toast({ title: 'Package saved' });
    setPkgDialog(null);
    loadAll();
  };

  const deletePackage = async (id: string) => {
    if (!confirm('Delete this package?')) return;
    const { error } = await supabase.from('ai_credit_packages').delete().eq('id', id);
    if (error) return toast({ title: 'Failed', description: error.message, variant: 'destructive' });
    toast({ title: 'Deleted' });
    loadAll();
  };

  const applyAdjustment = async () => {
    if (!adjustDialog) return;
    const delta = parseInt(adjustDelta, 10);
    if (!Number.isFinite(delta) || delta === 0) {
      return toast({ title: 'Enter a non-zero integer', variant: 'destructive' });
    }
    if (!adjustNotes.trim()) {
      return toast({ title: 'Reason required', description: 'Every adjustment must include a reason.', variant: 'destructive' });
    }
    const { error } = await supabase.rpc('adjust_merchant_credits' as any, {
      _merchant_id: adjustDialog.merchant_id,
      _delta: delta,
      _notes: adjustNotes,
    });
    if (error) return toast({ title: 'Failed', description: error.message, variant: 'destructive' });
    toast({ title: `Adjusted by ${delta}` });
    setAdjustDialog(null);
    setAdjustDelta('');
    setAdjustNotes('');
    loadAll();
  };

  const toggleSuspendAi = async (b: Balance) => {
    const next = !b.ai_access_suspended;
    const { error } = await supabase.from('merchants').update({ ai_access_suspended: next } as any).eq('id', b.merchant_id);
    if (error) return toast({ title: 'Failed', description: error.message, variant: 'destructive' });
    toast({ title: next ? 'AI access suspended' : 'AI access restored' });
    loadAll();
  };

  const fmtMoney = (amt: number, ccy: string) =>
    new Intl.NumberFormat('en-GB', { style: 'currency', currency: ccy || 'GBP' }).format(amt);

  return (
    <AdminLayout title="AI Image Credits" description="Manage merchant AI image generation credits, packages, usage and revenue">
      <div className="p-6 space-y-6">
        {/* Top stat cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <Card>
            <CardHeader className="pb-2"><CardDescription className="flex items-center gap-2"><Coins className="h-4 w-4" />Total Credits Issued</CardDescription></CardHeader>
            <CardContent><div className="text-2xl font-bold text-primary">{stats.issued.toLocaleString()}</div></CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardDescription className="flex items-center gap-2"><ImageIcon className="h-4 w-4" />Total Credits Used</CardDescription></CardHeader>
            <CardContent><div className="text-2xl font-bold">{stats.used.toLocaleString()}</div></CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardDescription className="flex items-center gap-2"><CreditCard className="h-4 w-4" />Total Credits Purchased</CardDescription></CardHeader>
            <CardContent><div className="text-2xl font-bold">{stats.purchased.toLocaleString()}</div></CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardDescription className="flex items-center gap-2"><TrendingUp className="h-4 w-4" />AI Revenue</CardDescription></CardHeader>
            <CardContent><div className="text-2xl font-bold text-emerald-400">{fmtMoney(stats.revenue, stats.currency)}</div></CardContent>
          </Card>
        </div>

        {/* Filters */}
        <Card>
          <CardContent className="pt-6 grid grid-cols-1 md:grid-cols-5 gap-3">
            <div>
              <Label className="text-xs">Service Area</Label>
              <Select value={fServiceArea} onValueChange={setFServiceArea}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All service areas</SelectItem>
                  {serviceAreas?.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Merchant Type</Label>
              <Select value={fType} onValueChange={setFType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All types</SelectItem>
                  {MERCHANT_TYPES.map((t) => <SelectItem key={t} value={t} className="capitalize">{t}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Merchant</Label>
              <Select value={fMerchant} onValueChange={setFMerchant}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All merchants</SelectItem>
                  {balances.map((b) => <SelectItem key={b.merchant_id} value={b.merchant_id}>{b.business_name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">From</Label>
              <Input type="date" value={fFrom} onChange={(e) => setFFrom(e.target.value)} />
            </div>
            <div>
              <Label className="text-xs">To</Label>
              <Input type="date" value={fTo} onChange={(e) => setFTo(e.target.value)} />
            </div>
          </CardContent>
        </Card>

        <Tabs defaultValue="settings" className="w-full">
          <TabsList className="flex-wrap h-auto">
            <TabsTrigger value="settings"><SettingsIcon className="h-4 w-4 mr-2" />Global Settings</TabsTrigger>
            <TabsTrigger value="packages"><Package className="h-4 w-4 mr-2" />Credit Packages</TabsTrigger>
            <TabsTrigger value="balances"><Users className="h-4 w-4 mr-2" />Merchant Balances</TabsTrigger>
            <TabsTrigger value="images"><ImageIcon className="h-4 w-4 mr-2" />AI Image History</TabsTrigger>
            <TabsTrigger value="payments"><CreditCard className="h-4 w-4 mr-2" />Payment History</TabsTrigger>
            <TabsTrigger value="history"><History className="h-4 w-4 mr-2" />Audit Log</TabsTrigger>
          </TabsList>

          {/* SETTINGS */}
          <TabsContent value="settings" className="mt-6">
            <Card>
              <CardHeader>
                <CardTitle>Global Credit Settings</CardTitle>
                <CardDescription>Source of truth for free credits, generation cost, and AI generation availability.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-5 max-w-xl">
                {!settings ? <div>Loading…</div> : (
                  <>
                    <div className="flex items-center justify-between border rounded-md p-3">
                      <div>
                        <div className="font-medium">AI Generation Enabled</div>
                        <div className="text-xs text-muted-foreground">When off, merchants cannot generate new AI images.</div>
                      </div>
                      <Switch checked={settings.ai_generation_enabled}
                        onCheckedChange={(v) => setSettings({ ...settings, ai_generation_enabled: v })} />
                    </div>
                    <div className="space-y-2">
                      <Label>Free Credits For New Merchant</Label>
                      <Input type="number" value={settings.free_credits_for_new_merchants}
                        onChange={(e) => setSettings({ ...settings, free_credits_for_new_merchants: Number(e.target.value) })} />
                      <p className="text-xs text-muted-foreground">Granted one-time only on first approval. Default 20.</p>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-2">
                        <Label>Credits Per Image</Label>
                        <Input type="number" value={settings.credit_cost_per_image}
                          onChange={(e) => setSettings({ ...settings, credit_cost_per_image: Number(e.target.value) })} />
                      </div>
                      <div className="space-y-2">
                        <Label>Credits Per Regeneration</Label>
                        <Input type="number" value={settings.credit_cost_per_regeneration}
                          onChange={(e) => setSettings({ ...settings, credit_cost_per_regeneration: Number(e.target.value) })} />
                      </div>
                    </div>
                    <div className="flex items-center justify-between border rounded-md p-3">
                      <div>
                        <div className="font-medium">Allow Credit Purchases</div>
                        <div className="text-xs text-muted-foreground">When off, the Buy Credits button is hidden in the merchant app.</div>
                      </div>
                      <Switch checked={settings.credit_purchase_enabled}
                        onCheckedChange={(v) => setSettings({ ...settings, credit_purchase_enabled: v })} />
                    </div>
                    <Button onClick={saveSettings}>Save settings</Button>
                  </>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* PACKAGES */}
          <TabsContent value="packages" className="mt-6">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <div>
                  <CardTitle>Credit Packages</CardTitle>
                  <CardDescription>Packages shown in the merchant app's Buy Credits screen.</CardDescription>
                </div>
                <Button onClick={() => { setPkgIsNew(true); setPkgDialog({ id: '', name: '', credits: 10, price: 2, currency: 'GBP', active: true, sort_order: (packages.at(-1)?.sort_order ?? 0) + 1 }); }}>
                  <Plus className="h-4 w-4 mr-2" />New package
                </Button>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Package Name</TableHead>
                      <TableHead>Credits</TableHead>
                      <TableHead>Price</TableHead>
                      <TableHead>Currency</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="w-12"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {packages.map((p) => (
                      <TableRow key={p.id}>
                        <TableCell className="font-medium">{p.name}</TableCell>
                        <TableCell>{p.credits}</TableCell>
                        <TableCell>{Number(p.price).toFixed(2)}</TableCell>
                        <TableCell>{p.currency}</TableCell>
                        <TableCell>
                          {p.active
                            ? <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/40" variant="outline">Active</Badge>
                            : <Badge variant="outline">Inactive</Badge>}
                        </TableCell>
                        <TableCell>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild><Button variant="ghost" size="icon"><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => { setPkgIsNew(false); setPkgDialog(p); }}><Pencil className="h-4 w-4 mr-2" />Edit</DropdownMenuItem>
                              <DropdownMenuItem className="text-destructive" onClick={() => deletePackage(p.id)}><Trash2 className="h-4 w-4 mr-2" />Delete</DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    ))}
                    {packages.length === 0 && (
                      <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">No packages yet</TableCell></TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          {/* BALANCES */}
          <TabsContent value="balances" className="mt-6">
            <Card>
              <CardHeader>
                <CardTitle>Merchant Credit Balances</CardTitle>
                <CardDescription>Per-merchant credit state, free-grant status, lifetime totals and AI access.</CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Merchant</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Service Area</TableHead>
                      <TableHead>Current Balance</TableHead>
                      <TableHead>Free Granted</TableHead>
                      <TableHead>Purchased</TableHead>
                      <TableHead>Used</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="w-12"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredBalances.map((b) => (
                      <TableRow key={b.merchant_id}>
                        <TableCell className="font-medium">{b.business_name}</TableCell>
                        <TableCell className="capitalize">{b.category}</TableCell>
                        <TableCell>{saName(b.service_area_id)}</TableCell>
                        <TableCell><span className="font-semibold text-primary">{b.credits_remaining}</span></TableCell>
                        <TableCell>{b.free_ai_credits_granted ? <Badge variant="outline" className="bg-emerald-500/20 text-emerald-400 border-emerald-500/40">Yes</Badge> : <Badge variant="outline">No</Badge>}</TableCell>
                        <TableCell>{b.total_purchased}</TableCell>
                        <TableCell>{b.total_used}</TableCell>
                        <TableCell>
                          {b.ai_access_suspended
                            ? <Badge variant="outline" className="bg-rose-500/20 text-rose-400 border-rose-500/40">AI Suspended</Badge>
                            : <Badge variant="outline" className="bg-emerald-500/20 text-emerald-400 border-emerald-500/40">Active</Badge>}
                        </TableCell>
                        <TableCell>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild><Button variant="ghost" size="icon"><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => { setFMerchant(b.merchant_id); }}>View activity</DropdownMenuItem>
                              <DropdownMenuItem onClick={() => { setAdjustDialog(b); setAdjustDelta('10'); }}>Add credits</DropdownMenuItem>
                              <DropdownMenuItem onClick={() => { setAdjustDialog(b); setAdjustDelta('-10'); }}>Remove credits</DropdownMenuItem>
                              <DropdownMenuItem onClick={() => toggleSuspendAi(b)}>
                                {b.ai_access_suspended
                                  ? <><ShieldCheck className="h-4 w-4 mr-2" />Restore AI access</>
                                  : <><Ban className="h-4 w-4 mr-2" />Suspend AI access</>}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    ))}
                    {filteredBalances.length === 0 && (
                      <TableRow><TableCell colSpan={9} className="text-center text-muted-foreground py-8">No merchants match filters</TableCell></TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          {/* AI IMAGE HISTORY */}
          <TabsContent value="images" className="mt-6">
            <Card>
              <CardHeader>
                <CardTitle>AI Image History</CardTitle>
                <CardDescription>Every AI image generated by merchants. Filters above apply.</CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Merchant</TableHead>
                      <TableHead>Product</TableHead>
                      <TableHead>Prompt</TableHead>
                      <TableHead>Credits</TableHead>
                      <TableHead>Image</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredGenerations.map((g) => (
                      <TableRow key={g.id}>
                        <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{new Date(g.created_at).toLocaleString()}</TableCell>
                        <TableCell>{g.merchants?.business_name ?? '—'}</TableCell>
                        <TableCell>{g.merchant_products?.name ?? '—'}</TableCell>
                        <TableCell className="max-w-md truncate" title={g.prompt}>{g.prompt}</TableCell>
                        <TableCell>{settings?.credit_cost_per_image ?? 1}</TableCell>
                        <TableCell>
                          {g.image_url
                            ? <a href={g.image_url} target="_blank" rel="noopener noreferrer"><img src={g.image_url} alt="" className="h-12 w-12 rounded object-cover border" /></a>
                            : <Badge variant="outline">{g.status}</Badge>}
                        </TableCell>
                      </TableRow>
                    ))}
                    {filteredGenerations.length === 0 && (
                      <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">No AI image generations yet</TableCell></TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          {/* PAYMENT HISTORY */}
          <TabsContent value="payments" className="mt-6">
            <Card>
              <CardHeader>
                <CardTitle>Payment History</CardTitle>
                <CardDescription>All credit package purchases via Stripe.</CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Merchant</TableHead>
                      <TableHead>Package</TableHead>
                      <TableHead>Credits</TableHead>
                      <TableHead>Amount</TableHead>
                      <TableHead>Stripe Payment ID</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredHistory.filter((h) => h.action_type === 'purchase').map((h) => {
                      const pkg = packages.find((p) => p.id === h.package_id);
                      return (
                        <TableRow key={h.id}>
                          <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{new Date(h.created_at).toLocaleString()}</TableCell>
                          <TableCell>{h.merchants?.business_name ?? '—'}</TableCell>
                          <TableCell>{pkg?.name ?? '—'}</TableCell>
                          <TableCell>+{h.credits_changed}</TableCell>
                          <TableCell>{pkg ? fmtMoney(Number(pkg.price), pkg.currency) : '—'}</TableCell>
                          <TableCell className="font-mono text-xs">{h.stripe_payment_id ?? '—'}</TableCell>
                          <TableCell><Badge variant="outline" className="bg-emerald-500/20 text-emerald-400 border-emerald-500/40">Completed</Badge></TableCell>
                        </TableRow>
                      );
                    })}
                    {filteredHistory.filter((h) => h.action_type === 'purchase').length === 0 && (
                      <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-8">No payments yet</TableCell></TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          {/* AUDIT LOG */}
          <TabsContent value="history" className="mt-6">
            <Card>
              <CardHeader>
                <CardTitle>Audit Log</CardTitle>
                <CardDescription>Every credit movement: grants, purchases, usage, refunds and manual adjustments.</CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Merchant</TableHead>
                      <TableHead>Action</TableHead>
                      <TableHead>Change</TableHead>
                      <TableHead>Balance After</TableHead>
                      <TableHead>Admin</TableHead>
                      <TableHead>Reason / Reference</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredHistory.map((h) => (
                      <TableRow key={h.id}>
                        <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{new Date(h.created_at).toLocaleString()}</TableCell>
                        <TableCell>{h.merchants?.business_name ?? '—'}</TableCell>
                        <TableCell><Badge variant="outline">{ACTION_LABEL[h.action_type] ?? h.action_type}</Badge></TableCell>
                        <TableCell className={h.credits_changed >= 0 ? 'text-emerald-400' : 'text-rose-400'}>{h.credits_changed > 0 ? `+${h.credits_changed}` : h.credits_changed}</TableCell>
                        <TableCell>{h.balance_after}</TableCell>
                        <TableCell className="font-mono text-xs">{h.admin_user_id ? h.admin_user_id.slice(0, 8) : '—'}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{h.notes ?? h.stripe_payment_id ?? '—'}</TableCell>
                      </TableRow>
                    ))}
                    {filteredHistory.length === 0 && (
                      <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-8">No credit activity yet</TableCell></TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>

      {/* Package edit dialog */}
      <Dialog open={!!pkgDialog} onOpenChange={(o) => !o && setPkgDialog(null)}>
        <DialogContent>
          {pkgDialog && (
            <>
              <DialogHeader>
                <DialogTitle>{pkgIsNew ? 'New package' : 'Edit package'}</DialogTitle>
                <DialogDescription>These packages are shown in the merchant app's Buy Credits screen.</DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <div><Label>Name</Label><Input value={pkgDialog.name} onChange={(e) => setPkgDialog({ ...pkgDialog, name: e.target.value })} /></div>
                <div className="grid grid-cols-2 gap-3">
                  <div><Label>Credits</Label><Input type="number" value={pkgDialog.credits} onChange={(e) => setPkgDialog({ ...pkgDialog, credits: Number(e.target.value) })} /></div>
                  <div><Label>Price</Label><Input type="number" step="0.01" value={pkgDialog.price} onChange={(e) => setPkgDialog({ ...pkgDialog, price: Number(e.target.value) })} /></div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div><Label>Currency</Label><Input value={pkgDialog.currency} onChange={(e) => setPkgDialog({ ...pkgDialog, currency: e.target.value.toUpperCase() })} /></div>
                  <div><Label>Sort order</Label><Input type="number" value={pkgDialog.sort_order} onChange={(e) => setPkgDialog({ ...pkgDialog, sort_order: Number(e.target.value) })} /></div>
                </div>
                <div className="flex items-center justify-between border rounded-md p-3">
                  <Label>Active</Label>
                  <Switch checked={pkgDialog.active} onCheckedChange={(v) => setPkgDialog({ ...pkgDialog, active: v })} />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setPkgDialog(null)}>Cancel</Button>
                <Button onClick={savePackage}>Save</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Adjust credits dialog */}
      <Dialog open={!!adjustDialog} onOpenChange={(o) => !o && setAdjustDialog(null)}>
        <DialogContent>
          {adjustDialog && (
            <>
              <DialogHeader>
                <DialogTitle>Adjust credits — {adjustDialog.business_name}</DialogTitle>
                <DialogDescription>Current balance: {adjustDialog.credits_remaining}. Positive numbers add, negative numbers remove. A reason is required and stored in the audit log.</DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <div><Label>Credits delta (e.g. 10 or -5)</Label><Input type="number" value={adjustDelta} onChange={(e) => setAdjustDelta(e.target.value)} /></div>
                <div><Label>Reason <span className="text-destructive">*</span></Label><Input value={adjustNotes} onChange={(e) => setAdjustNotes(e.target.value)} placeholder="Reason for adjustment" /></div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setAdjustDialog(null)}>Cancel</Button>
                <Button onClick={applyAdjustment}>Apply</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
}
