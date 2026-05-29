import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { MoreHorizontal, Plus, Store, Search } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { useServiceAreas } from '@/hooks/useServiceAreas';
import { MerchantFormDialog } from '@/components/merchants/MerchantFormDialog';

type Category = 'food' | 'grocery' | 'retail' | 'pharmacy' | 'parcel';
const CATEGORIES: Category[] = ['food', 'grocery', 'retail', 'pharmacy', 'parcel'];

interface MerchantRow {
  id: string;
  business_name: string;
  category: Category;
  service_area_id: string;
  owner_name: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  status: string;
  is_open: boolean;
  created_at: string;
}

interface SAMerchantSetting {
  id: string;
  service_area_id: string;
  category: Category;
  enabled: boolean;
  delivery_enabled: boolean;
}

export default function MerchantManagement() {
  const navigate = useNavigate();
  const { serviceAreas } = useServiceAreas();
  const [globalCats, setGlobalCats] = useState<{ category: Category; enabled: boolean; display_name: string }[]>([]);
  const [merchants, setMerchants] = useState<MerchantRow[]>([]);
  const [saSettings, setSaSettings] = useState<SAMerchantSetting[]>([]);
  const [selectedSA, setSelectedSA] = useState<string>('');
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [filterCategory, setFilterCategory] = useState<string>('all');
  const [filterSA, setFilterSA] = useState<string>('all');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<MerchantRow | null>(null);
  const [stats, setStats] = useState({ total: 0, active: 0, pending: 0, suspended: 0, orders: 0, revenue: 0 });

  const load = async () => {
    const [{ data: cats }, { data: ms }, { data: sas }] = await Promise.all([
      supabase.from('merchant_categories').select('*').order('display_name'),
      supabase.from('merchants').select('*').order('created_at', { ascending: false }),
      supabase.from('service_area_merchant_settings').select('*'),
    ]);
    setGlobalCats((cats as any) ?? []);
    setMerchants((ms as any) ?? []);
    setSaSettings((sas as any) ?? []);

    const total = ms?.length ?? 0;
    const active = ms?.filter((m: any) => m.status === 'approved').length ?? 0;
    const pending = ms?.filter((m: any) => m.status === 'pending').length ?? 0;
    const suspended = ms?.filter((m: any) => m.status === 'suspended').length ?? 0;

    // Reuse existing trips table for delivery orders
    const { data: ords } = await supabase
      .from('trips' as any)
      .select('id, total_fare', { count: 'exact' })
      .eq('booking_type', 'delivery' as any)
      .limit(1000);
    const ordersCount = ords?.length ?? 0;
    const revenue = (ords ?? []).reduce((s: number, t: any) => s + (Number(t.total_fare) || 0), 0);

    setStats({ total, active, pending, suspended, orders: ordersCount, revenue });
  };

  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (!selectedSA && serviceAreas?.length) setSelectedSA(serviceAreas[0].id);
  }, [serviceAreas, selectedSA]);

  const toggleGlobalCategory = async (cat: Category, enabled: boolean) => {
    const { error } = await supabase.from('merchant_categories').update({ enabled, updated_at: new Date().toISOString() }).eq('category', cat);
    if (error) return toast({ title: 'Failed', description: error.message, variant: 'destructive' });
    setGlobalCats((prev) => prev.map((c) => (c.category === cat ? { ...c, enabled } : c)));
    toast({ title: 'Updated', description: `${cat} ${enabled ? 'enabled' : 'disabled'} globally` });
  };

  const getSASetting = (sa: string, cat: Category) =>
    saSettings.find((s) => s.service_area_id === sa && s.category === cat);

  const toggleSASetting = async (sa: string, cat: Category, field: 'enabled' | 'delivery_enabled', value: boolean) => {
    const existing = getSASetting(sa, cat);
    if (existing) {
      const { error } = await supabase
        .from('service_area_merchant_settings')
        .update({ [field]: value, updated_at: new Date().toISOString() })
        .eq('id', existing.id);
      if (error) return toast({ title: 'Failed', description: error.message, variant: 'destructive' });
      setSaSettings((prev) => prev.map((s) => (s.id === existing.id ? { ...s, [field]: value } : s)));
    } else {
      const payload: any = { service_area_id: sa, category: cat, enabled: false, delivery_enabled: false };
      payload[field] = value;
      const { data, error } = await supabase.from('service_area_merchant_settings').insert(payload).select().single();
      if (error) return toast({ title: 'Failed', description: error.message, variant: 'destructive' });
      setSaSettings((prev) => [...prev, data as any]);
    }
  };

  const updateMerchantStatus = async (id: string, status: string) => {
    const { error } = await supabase.from('merchants').update({ status: status as any }).eq('id', id);
    if (error) return toast({ title: 'Failed', description: error.message, variant: 'destructive' });
    toast({ title: 'Updated', description: `Merchant ${status}` });
    load();
  };

  const deleteMerchant = async (id: string) => {
    if (!confirm('Delete this merchant permanently? This cannot be undone.')) return;
    const { error } = await supabase.from('merchants').delete().eq('id', id);
    if (error) return toast({ title: 'Failed', description: error.message, variant: 'destructive' });
    toast({ title: 'Deleted' });
    load();
  };

  const filtered = merchants.filter((m) => {
    if (search && !m.business_name.toLowerCase().includes(search.toLowerCase())) return false;
    if (filterStatus !== 'all' && m.status !== filterStatus) return false;
    if (filterCategory !== 'all' && m.category !== filterCategory) return false;
    if (filterSA !== 'all' && m.service_area_id !== filterSA) return false;
    return true;
  });

  const saName = (id: string) => serviceAreas?.find((s: any) => s.id === id)?.name ?? '—';

  const statusBadge = (s: string) => {
    const variants: Record<string, string> = {
      approved: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40',
      pending: 'bg-amber-500/20 text-amber-400 border-amber-500/40',
      rejected: 'bg-rose-500/20 text-rose-400 border-rose-500/40',
      suspended: 'bg-rose-500/20 text-rose-400 border-rose-500/40',
      closed: 'bg-muted text-muted-foreground border-muted',
    };
    return <Badge variant="outline" className={variants[s] ?? ''}>{s}</Badge>;
  };

  return (
    <AdminLayout title="Merchant Management" subtitle="Marketplace for food, grocery, retail, pharmacy & parcel delivery">
      <div className="space-y-6 p-6">
        {/* Overview cards */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          {[
            { label: 'Total merchants', value: stats.total },
            { label: 'Active', value: stats.active },
            { label: 'Pending', value: stats.pending },
            { label: 'Suspended', value: stats.suspended },
            { label: 'Marketplace orders', value: stats.orders },
            { label: 'Marketplace revenue', value: `£${stats.revenue.toFixed(2)}` },
          ].map((c) => (
            <Card key={c.label}>
              <CardContent className="p-4">
                <div className="text-xs text-muted-foreground">{c.label}</div>
                <div className="text-2xl font-semibold text-primary">{c.value}</div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Global Merchant Type Controls */}
        <Card>
          <CardHeader>
            <CardTitle>Global Merchant Type Controls</CardTitle>
            <CardDescription>Turn marketplace categories on or off globally. Categories turned OFF are hidden from the customer app everywhere.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              {globalCats.map((c) => (
                <div key={c.category} className="flex items-center justify-between border rounded-lg p-3">
                  <Label className="capitalize">{c.display_name}</Label>
                  <Switch checked={c.enabled} onCheckedChange={(v) => toggleGlobalCategory(c.category, v)} />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Per-service-area controls */}
        <Card>
          <CardHeader>
            <CardTitle>Per-Service-Area Controls</CardTitle>
            <CardDescription>Pick a service area and choose which merchant types are visible to customers there.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="max-w-sm">
              <Label className="mb-2 block">Service Area</Label>
              <Select value={selectedSA} onValueChange={setSelectedSA}>
                <SelectTrigger><SelectValue placeholder="Select service area" /></SelectTrigger>
                <SelectContent>
                  {serviceAreas?.map((sa: any) => (
                    <SelectItem key={sa.id} value={sa.id}>{sa.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {selectedSA && (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                <div className="flex items-center justify-between border rounded-lg p-3 bg-muted/30">
                  <Label>Delivery enabled (master)</Label>
                  <Switch
                    checked={CATEGORIES.some((c) => getSASetting(selectedSA, c)?.delivery_enabled)}
                    onCheckedChange={async (v) => {
                      for (const c of CATEGORIES) await toggleSASetting(selectedSA, c, 'delivery_enabled', v);
                    }}
                  />
                </div>
                {CATEGORIES.map((c) => {
                  const s = getSASetting(selectedSA, c);
                  return (
                    <div key={c} className="flex items-center justify-between border rounded-lg p-3">
                      <Label className="capitalize">{c}</Label>
                      <Switch checked={!!s?.enabled} onCheckedChange={(v) => toggleSASetting(selectedSA, c, 'enabled', v)} />
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Merchants */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2"><Store className="h-5 w-5" /> Merchants</CardTitle>
              <CardDescription>All registered businesses across service areas.</CardDescription>
            </div>
            <Button onClick={() => { setEditing(null); setDialogOpen(true); }}>
              <Plus className="h-4 w-4" /> Add Merchant
            </Button>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input className="pl-9" placeholder="Search merchants…" value={search} onChange={(e) => setSearch(e.target.value)} />
              </div>
              <Select value={filterStatus} onValueChange={setFilterStatus}>
                <SelectTrigger className="w-[150px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="approved">Approved</SelectItem>
                  <SelectItem value="rejected">Rejected</SelectItem>
                  <SelectItem value="suspended">Suspended</SelectItem>
                  <SelectItem value="closed">Closed</SelectItem>
                </SelectContent>
              </Select>
              <Select value={filterCategory} onValueChange={setFilterCategory}>
                <SelectTrigger className="w-[150px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All categories</SelectItem>
                  {CATEGORIES.map((c) => <SelectItem key={c} value={c} className="capitalize">{c}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={filterSA} onValueChange={setFilterSA}>
                <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All service areas</SelectItem>
                  {serviceAreas?.map((sa: any) => <SelectItem key={sa.id} value={sa.id}>{sa.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            <div className="rounded-md border overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Business</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Service area</TableHead>
                    <TableHead>Owner</TableHead>
                    <TableHead>Contact</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Open</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="w-12"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.length === 0 && (
                    <TableRow><TableCell colSpan={9} className="text-center text-muted-foreground py-8">No merchants yet</TableCell></TableRow>
                  )}
                  {filtered.map((m) => (
                    <TableRow key={m.id} className="cursor-pointer" onClick={() => navigate(`/merchants/${m.id}`)}>
                      <TableCell className="font-medium">{m.business_name}</TableCell>
                      <TableCell className="capitalize">{m.category}</TableCell>
                      <TableCell>{saName(m.service_area_id)}</TableCell>
                      <TableCell>{m.owner_name ?? '—'}</TableCell>
                      <TableCell className="text-xs">
                        {m.phone && <div>{m.phone}</div>}
                        {m.email && <div className="text-muted-foreground">{m.email}</div>}
                      </TableCell>
                      <TableCell>{statusBadge(m.status)}</TableCell>
                      <TableCell>{m.is_open ? <Badge variant="outline" className="bg-emerald-500/20 text-emerald-400 border-emerald-500/40">Open</Badge> : <Badge variant="outline">Closed</Badge>}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{new Date(m.created_at).toLocaleDateString()}</TableCell>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon"><MoreHorizontal className="h-4 w-4" /></Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => navigate(`/merchants/${m.id}`)}>View</DropdownMenuItem>
                            <DropdownMenuItem onClick={() => { setEditing(m); setDialogOpen(true); }}>Edit</DropdownMenuItem>
                            <DropdownMenuSeparator />
                            {m.status !== 'approved' && <DropdownMenuItem onClick={() => updateMerchantStatus(m.id, 'approved')}>Approve</DropdownMenuItem>}
                            {m.status !== 'rejected' && <DropdownMenuItem onClick={() => updateMerchantStatus(m.id, 'rejected')}>Reject</DropdownMenuItem>}
                            {m.status !== 'suspended' && <DropdownMenuItem onClick={() => updateMerchantStatus(m.id, 'suspended')}>Suspend</DropdownMenuItem>}
                            <DropdownMenuSeparator />
                            <DropdownMenuItem className="text-destructive" onClick={() => deleteMerchant(m.id)}>Delete</DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>

      <MerchantFormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        merchant={editing}
        onSaved={() => { setDialogOpen(false); load(); }}
      />
    </AdminLayout>
  );
}
