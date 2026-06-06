import { useEffect, useState } from 'react';
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
import { MoreHorizontal, Plus, Coins, Package, History, Settings as SettingsIcon, Pencil, Trash2 } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { useServiceAreas } from '@/hooks/useServiceAreas';

type Settings = {
  free_credits_for_new_merchants: number;
  credit_cost_per_image: number;
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
  credits_remaining: number;
  free_ai_credits_granted: boolean;
  total_purchased: number;
  total_used: number;
};
type HistoryRow = {
  id: string;
  merchant_id: string;
  action_type: string;
  credits_changed: number;
  balance_after: number;
  admin_user_id: string | null;
  stripe_payment_id: string | null;
  notes: string | null;
  created_at: string;
  merchants?: { business_name: string } | null;
};

const ACTION_LABEL: Record<string, string> = {
  free_grant: 'Free Grant',
  purchase: 'Purchase',
  generation_used: 'Generation Used',
  manual_adjustment: 'Manual Adjustment',
  refund: 'Refund',
};

export default function AiImageCredits() {
  const { data: serviceAreas } = useServiceAreas();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [packages, setPackages] = useState<Pkg[]>([]);
  const [balances, setBalances] = useState<Balance[]>([]);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [pkgDialog, setPkgDialog] = useState<Pkg | null>(null);
  const [pkgIsNew, setPkgIsNew] = useState(false);
  const [adjustDialog, setAdjustDialog] = useState<Balance | null>(null);
  const [adjustDelta, setAdjustDelta] = useState('');
  const [adjustNotes, setAdjustNotes] = useState('');
  const [historyMerchant, setHistoryMerchant] = useState<Balance | null>(null);
  const [merchantHistory, setMerchantHistory] = useState<HistoryRow[]>([]);

  const loadAll = async () => {
    const [s, p, m, h] = await Promise.all([
      supabase.from('ai_credit_settings').select('*').eq('id', true).maybeSingle(),
      supabase.from('ai_credit_packages').select('*').order('sort_order'),
      supabase.from('merchants').select('id,business_name,category,service_area_id,free_ai_credits_granted'),
      supabase.from('merchant_ai_credit_history').select('*, merchants(business_name)').order('created_at', { ascending: false }).limit(200),
    ]);
    if (s.data) setSettings(s.data as any);
    if (p.data) setPackages(p.data as any);
    if (h.data) setHistory(h.data as any);

    // Balances + aggregates
    const merchantIds = (m.data ?? []).map((x: any) => x.id);
    const [credits, agg] = await Promise.all([
      supabase.from('merchant_ai_credits').select('merchant_id,credits_remaining').in('merchant_id', merchantIds),
      supabase.from('merchant_ai_credit_history').select('merchant_id,action_type,credits_changed').in('merchant_id', merchantIds),
    ]);
    const credMap = new Map<string, number>();
    (credits.data ?? []).forEach((r: any) => credMap.set(r.merchant_id, r.credits_remaining));
    const purchased = new Map<string, number>();
    const used = new Map<string, number>();
    (agg.data ?? []).forEach((r: any) => {
      if (r.action_type === 'purchase') purchased.set(r.merchant_id, (purchased.get(r.merchant_id) ?? 0) + r.credits_changed);
      if (r.action_type === 'generation_used') used.set(r.merchant_id, (used.get(r.merchant_id) ?? 0) + Math.abs(r.credits_changed));
    });
    setBalances((m.data ?? []).map((row: any) => ({
      merchant_id: row.id,
      business_name: row.business_name,
      category: row.category,
      service_area_id: row.service_area_id,
      credits_remaining: credMap.get(row.id) ?? 0,
      free_ai_credits_granted: row.free_ai_credits_granted,
      total_purchased: purchased.get(row.id) ?? 0,
      total_used: used.get(row.id) ?? 0,
    })));
  };

  useEffect(() => { loadAll(); }, []);

  const saName = (id: string) => serviceAreas?.find((s) => s.id === id)?.name ?? '—';

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
    const { error } = await supabase.rpc('adjust_merchant_credits' as any, {
      _merchant_id: adjustDialog.merchant_id,
      _delta: delta,
      _notes: adjustNotes || null,
    });
    if (error) return toast({ title: 'Failed', description: error.message, variant: 'destructive' });
    toast({ title: `Adjusted by ${delta}` });
    setAdjustDialog(null);
    setAdjustDelta('');
    setAdjustNotes('');
    loadAll();
  };

  const openHistory = async (b: Balance) => {
    setHistoryMerchant(b);
    const { data } = await supabase
      .from('merchant_ai_credit_history')
      .select('*')
      .eq('merchant_id', b.merchant_id)
      .order('created_at', { ascending: false });
    setMerchantHistory((data as any) ?? []);
  };

  return (
    <AdminLayout title="AI Image Credits" description="Manage free credits, paid packages and merchant balances">
      <div className="p-6 space-y-6">
        <Tabs defaultValue="settings" className="w-full">
          <TabsList>
            <TabsTrigger value="settings"><SettingsIcon className="h-4 w-4 mr-2" />Global Settings</TabsTrigger>
            <TabsTrigger value="packages"><Package className="h-4 w-4 mr-2" />Credit Packages</TabsTrigger>
            <TabsTrigger value="balances"><Coins className="h-4 w-4 mr-2" />Merchant Balances</TabsTrigger>
            <TabsTrigger value="history"><History className="h-4 w-4 mr-2" />Credit History</TabsTrigger>
          </TabsList>

          {/* SETTINGS */}
          <TabsContent value="settings" className="mt-6">
            <Card>
              <CardHeader>
                <CardTitle>Global Credit Settings</CardTitle>
                <CardDescription>Source of truth for free credits and AI generation availability.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-5 max-w-xl">
                {!settings ? <div>Loading…</div> : (
                  <>
                    <div className="space-y-2">
                      <Label>Free credits for new approved merchants</Label>
                      <Input type="number" value={settings.free_credits_for_new_merchants}
                        onChange={(e) => setSettings({ ...settings, free_credits_for_new_merchants: Number(e.target.value) })} />
                      <p className="text-xs text-muted-foreground">Granted one-time only on first approval.</p>
                    </div>
                    <div className="space-y-2">
                      <Label>Credit cost per generated image</Label>
                      <Input type="number" value={settings.credit_cost_per_image}
                        onChange={(e) => setSettings({ ...settings, credit_cost_per_image: Number(e.target.value) })} />
                    </div>
                    <div className="flex items-center justify-between border rounded-md p-3">
                      <div>
                        <div className="font-medium">Enable AI generation</div>
                        <div className="text-xs text-muted-foreground">When off, merchants cannot generate new AI images.</div>
                      </div>
                      <Switch checked={settings.ai_generation_enabled}
                        onCheckedChange={(v) => setSettings({ ...settings, ai_generation_enabled: v })} />
                    </div>
                    <div className="flex items-center justify-between border rounded-md p-3">
                      <div>
                        <div className="font-medium">Enable credit purchase</div>
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
                      <TableHead>Name</TableHead>
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
                        <TableCell>{p.price.toFixed(2)}</TableCell>
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
                <CardDescription>Per-merchant credit state, free-grant status and lifetime totals.</CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Merchant</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Service Area</TableHead>
                      <TableHead>Remaining</TableHead>
                      <TableHead>Free granted</TableHead>
                      <TableHead>Purchased</TableHead>
                      <TableHead>Used</TableHead>
                      <TableHead className="w-12"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {balances.map((b) => (
                      <TableRow key={b.merchant_id}>
                        <TableCell className="font-medium">{b.business_name}</TableCell>
                        <TableCell className="capitalize">{b.category}</TableCell>
                        <TableCell>{saName(b.service_area_id)}</TableCell>
                        <TableCell><span className="font-semibold text-primary">{b.credits_remaining}</span></TableCell>
                        <TableCell>{b.free_ai_credits_granted ? <Badge variant="outline" className="bg-emerald-500/20 text-emerald-400 border-emerald-500/40">Yes</Badge> : <Badge variant="outline">No</Badge>}</TableCell>
                        <TableCell>{b.total_purchased}</TableCell>
                        <TableCell>{b.total_used}</TableCell>
                        <TableCell>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild><Button variant="ghost" size="icon"><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => { setAdjustDialog(b); setAdjustDelta('10'); }}>Add credits</DropdownMenuItem>
                              <DropdownMenuItem onClick={() => { setAdjustDialog(b); setAdjustDelta('-10'); }}>Remove credits</DropdownMenuItem>
                              <DropdownMenuItem onClick={() => openHistory(b)}>View history</DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    ))}
                    {balances.length === 0 && (
                      <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground py-8">No merchants yet</TableCell></TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          {/* HISTORY */}
          <TabsContent value="history" className="mt-6">
            <Card>
              <CardHeader>
                <CardTitle>Credit History</CardTitle>
                <CardDescription>Most recent 200 credit movements across all merchants.</CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Merchant</TableHead>
                      <TableHead>Action</TableHead>
                      <TableHead>Change</TableHead>
                      <TableHead>Balance after</TableHead>
                      <TableHead>Stripe Payment</TableHead>
                      <TableHead>Notes</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {history.map((h) => (
                      <TableRow key={h.id}>
                        <TableCell className="text-xs text-muted-foreground">{new Date(h.created_at).toLocaleString()}</TableCell>
                        <TableCell>{h.merchants?.business_name ?? '—'}</TableCell>
                        <TableCell><Badge variant="outline">{ACTION_LABEL[h.action_type] ?? h.action_type}</Badge></TableCell>
                        <TableCell className={h.credits_changed >= 0 ? 'text-emerald-400' : 'text-rose-400'}>{h.credits_changed > 0 ? `+${h.credits_changed}` : h.credits_changed}</TableCell>
                        <TableCell>{h.balance_after}</TableCell>
                        <TableCell className="text-xs">{h.stripe_payment_id ?? '—'}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{h.notes ?? '—'}</TableCell>
                      </TableRow>
                    ))}
                    {history.length === 0 && (
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
                <DialogDescription>Current balance: {adjustDialog.credits_remaining}. Positive numbers add, negative numbers remove.</DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <div><Label>Credits delta (e.g. 10 or -5)</Label><Input type="number" value={adjustDelta} onChange={(e) => setAdjustDelta(e.target.value)} /></div>
                <div><Label>Notes (optional)</Label><Input value={adjustNotes} onChange={(e) => setAdjustNotes(e.target.value)} placeholder="Reason for adjustment" /></div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setAdjustDialog(null)}>Cancel</Button>
                <Button onClick={applyAdjustment}>Apply</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Merchant history dialog */}
      <Dialog open={!!historyMerchant} onOpenChange={(o) => !o && setHistoryMerchant(null)}>
        <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
          {historyMerchant && (
            <>
              <DialogHeader>
                <DialogTitle>Credit history — {historyMerchant.business_name}</DialogTitle>
              </DialogHeader>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>Change</TableHead>
                    <TableHead>Balance</TableHead>
                    <TableHead>Notes</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {merchantHistory.map((h) => (
                    <TableRow key={h.id}>
                      <TableCell className="text-xs">{new Date(h.created_at).toLocaleString()}</TableCell>
                      <TableCell><Badge variant="outline">{ACTION_LABEL[h.action_type] ?? h.action_type}</Badge></TableCell>
                      <TableCell className={h.credits_changed >= 0 ? 'text-emerald-400' : 'text-rose-400'}>{h.credits_changed > 0 ? `+${h.credits_changed}` : h.credits_changed}</TableCell>
                      <TableCell>{h.balance_after}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{h.notes ?? h.stripe_payment_id ?? '—'}</TableCell>
                    </TableRow>
                  ))}
                  {merchantHistory.length === 0 && (
                    <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground py-6">No history yet</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </>
          )}
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
}
