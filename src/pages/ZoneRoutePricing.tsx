import { useState, useEffect } from 'react';
import { PageWrapper } from '@/components/layout/PageWrapper';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, Loader2, Route } from 'lucide-react';

interface ZoneRouteRule {
  id: string;
  from_zone_id: string;
  to_zone_id: string;
  service_area_id: string | null;
  vehicle_type_id: string | null;
  fixed_fare: number;
  is_active: boolean;
  priority: number;
  created_at: string;
}

interface Zone {
  id: string;
  name: string;
  region_id: string | null;
  service_area_id: string | null;
}

interface VehicleType {
  id: string;
  name: string;
}

interface ServiceArea {
  id: string;
  name: string;
}

const emptyForm = {
  from_zone_id: '',
  to_zone_id: '',
  service_area_id: '',
  vehicle_type_id: '',
  fixed_fare: '',
  is_active: true,
  priority: '0',
};

export default function ZoneRoutePricing() {
  const [rules, setRules] = useState<ZoneRouteRule[]>([]);
  const [zones, setZones] = useState<Zone[]>([]);
  const [vehicleTypes, setVehicleTypes] = useState<VehicleType[]>([]);
  const [serviceAreas, setServiceAreas] = useState<ServiceArea[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);

  const fetchAll = async () => {
    setLoading(true);
    const [rulesRes, zonesRes, vtRes, saRes] = await Promise.all([
      supabase.from('zone_route_pricing').select('*').order('priority', { ascending: false }),
      supabase.from('custom_zones').select('id, name, region_id, service_area_id').eq('zone_type', 'PRICING').eq('is_active', true),
      supabase.from('vehicle_types').select('id, name').eq('is_active', true),
      supabase.from('service_areas').select('id, name').eq('is_active', true),
    ]);
    if (rulesRes.data) setRules(rulesRes.data as ZoneRouteRule[]);
    if (zonesRes.data) setZones(zonesRes.data as Zone[]);
    if (vtRes.data) setVehicleTypes(vtRes.data as VehicleType[]);
    if (saRes.data) setServiceAreas(saRes.data as ServiceArea[]);
    setLoading(false);
  };

  useEffect(() => { fetchAll(); }, []);

  const openCreate = () => {
    setEditingId(null);
    setForm(emptyForm);
    setDialogOpen(true);
  };

  const openEdit = (r: ZoneRouteRule) => {
    setEditingId(r.id);
    setForm({
      from_zone_id: r.from_zone_id,
      to_zone_id: r.to_zone_id,
      service_area_id: r.service_area_id || '',
      vehicle_type_id: r.vehicle_type_id || '',
      fixed_fare: String(r.fixed_fare),
      is_active: r.is_active,
      priority: String(r.priority),
    });
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!form.from_zone_id || !form.to_zone_id || !form.fixed_fare) {
      toast.error('From Zone, To Zone, and Fixed Fare are required');
      return;
    }
    if (form.from_zone_id === form.to_zone_id) {
      toast.error('From Zone and To Zone must be different');
      return;
    }
    setSaving(true);
    const payload = {
      from_zone_id: form.from_zone_id,
      to_zone_id: form.to_zone_id,
      service_area_id: form.service_area_id || null,
      vehicle_type_id: form.vehicle_type_id || null,
      fixed_fare: parseFloat(form.fixed_fare),
      is_active: form.is_active,
      priority: parseInt(form.priority) || 0,
    };

    let error;
    if (editingId) {
      ({ error } = await supabase.from('zone_route_pricing').update(payload).eq('id', editingId));
    } else {
      ({ error } = await supabase.from('zone_route_pricing').insert(payload));
    }

    if (error) {
      toast.error(error.message);
    } else {
      toast.success(editingId ? 'Route updated' : 'Route created');
      setDialogOpen(false);
      fetchAll();
    }
    setSaving(false);
  };

  const handleDelete = async (id: string) => {
    const { error } = await supabase.from('zone_route_pricing').delete().eq('id', id);
    if (error) toast.error(error.message);
    else { toast.success('Route deleted'); fetchAll(); }
  };

  const handleToggle = async (id: string, active: boolean) => {
    const { error } = await supabase.from('zone_route_pricing').update({ is_active: active }).eq('id', id);
    if (error) toast.error(error.message);
    else fetchAll();
  };

  const zoneName = (id: string) => zones.find(z => z.id === id)?.name || 'Unknown';
  const vehicleName = (id: string | null) => id ? vehicleTypes.find(v => v.id === id)?.name || 'Unknown' : 'All';
  const serviceAreaName = (id: string | null) => id ? serviceAreas.find(s => s.id === id)?.name || 'Unknown' : '—';

  return (
    <PageWrapper title="Zone Route Pricing" description="Define fixed fares between two pricing zones (e.g. Heathrow → Milton Keynes = £65). Overrides distance pricing when matched.">
      <div className="space-y-6">
        <div className="flex justify-end">
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4 mr-2" /> Add Route
          </Button>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Route className="h-5 w-5" /> Route Pricing Rules</CardTitle>
            <CardDescription>
              Directional: Heathrow → MK is separate from MK → Heathrow. Higher priority wins when multiple routes match.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
            ) : rules.length === 0 ? (
              <p className="text-center py-12 text-muted-foreground">No zone route pricing rules yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>From Zone</TableHead>
                    <TableHead>To Zone</TableHead>
                    <TableHead>Vehicle</TableHead>
                    <TableHead>Fixed Fare</TableHead>
                    <TableHead>Priority</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rules.map(r => (
                    <TableRow key={r.id}>
                      <TableCell className="font-medium">{zoneName(r.from_zone_id)}</TableCell>
                      <TableCell>{zoneName(r.to_zone_id)}</TableCell>
                      <TableCell>{vehicleName(r.vehicle_type_id)}</TableCell>
                      <TableCell>£{Number(r.fixed_fare).toFixed(2)}</TableCell>
                      <TableCell>{r.priority}</TableCell>
                      <TableCell>
                        <Switch checked={r.is_active} onCheckedChange={(v) => handleToggle(r.id, v)} />
                      </TableCell>
                      <TableCell className="text-right space-x-1">
                        <Button variant="ghost" size="icon" onClick={() => openEdit(r)}><Pencil className="h-4 w-4" /></Button>
                        <Button variant="ghost" size="icon" onClick={() => handleDelete(r.id)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>{editingId ? 'Edit Route Pricing' : 'New Route Pricing'}</DialogTitle>
              <DialogDescription>Set a fixed fare between two pricing zones. Direction matters.</DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>From Zone *</Label>
                  <Select value={form.from_zone_id} onValueChange={v => setForm(f => ({ ...f, from_zone_id: v }))}>
                    <SelectTrigger><SelectValue placeholder="Select zone" /></SelectTrigger>
                    <SelectContent>{zones.map(z => <SelectItem key={z.id} value={z.id}>{z.name}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>To Zone *</Label>
                  <Select value={form.to_zone_id} onValueChange={v => setForm(f => ({ ...f, to_zone_id: v }))}>
                    <SelectTrigger><SelectValue placeholder="Select zone" /></SelectTrigger>
                    <SelectContent>{zones.map(z => <SelectItem key={z.id} value={z.id}>{z.name}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Service Area</Label>
                  <Select value={form.service_area_id} onValueChange={v => setForm(f => ({ ...f, service_area_id: v }))}>
                    <SelectTrigger><SelectValue placeholder="Optional" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="">Any</SelectItem>
                      {serviceAreas.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Vehicle Type</Label>
                  <Select value={form.vehicle_type_id} onValueChange={v => setForm(f => ({ ...f, vehicle_type_id: v }))}>
                    <SelectTrigger><SelectValue placeholder="All vehicles" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="">All</SelectItem>
                      {vehicleTypes.map(v => <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Fixed Fare (£) *</Label>
                  <Input type="number" step="0.01" min="0" placeholder="65.00" value={form.fixed_fare} onChange={e => setForm(f => ({ ...f, fixed_fare: e.target.value }))} />
                </div>
                <div className="space-y-2">
                  <Label>Priority</Label>
                  <Input type="number" min="0" placeholder="0" value={form.priority} onChange={e => setForm(f => ({ ...f, priority: e.target.value }))} />
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Switch checked={form.is_active} onCheckedChange={v => setForm(f => ({ ...f, is_active: v }))} />
                <Label>Active</Label>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button onClick={handleSave} disabled={saving}>
                {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                {editingId ? 'Update' : 'Create'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </PageWrapper>
  );
}
