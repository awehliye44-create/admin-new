import { useState, useEffect, useMemo } from 'react';
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
import { Plus, Pencil, Trash2, Loader2, Route, ChevronDown, ChevronRight } from 'lucide-react';

interface ZoneRouteRule {
  id: string;
  from_zone_id: string;
  to_zone_id: string;
  service_area_id: string | null;
  vehicle_type_id: string | null;
  fixed_fare: number;
  pickup_fee: number;
  dropoff_fee: number;
  surcharge_pct: number;
  airport_pickup_fee: number;
  airport_dropoff_fee: number;
  is_active: boolean;
  priority: number;
}

interface Zone { id: string; name: string; }
interface VehicleType { id: string; name: string; }
interface ServiceArea { id: string; name: string; }

// One row per vehicle category in the matrix editor
interface MatrixRow {
  vehicle_type_id: string | null; // null = explicit fallback
  fixed_fare: string;
  pickup_fee: string;
  dropoff_fee: string;
  surcharge_pct: string;
  airport_pickup_fee: string;
  airport_dropoff_fee: string;
  is_active: boolean;
  existing_id: string | null;
}

const blankRow = (vehicle_type_id: string | null): MatrixRow => ({
  vehicle_type_id,
  fixed_fare: '',
  pickup_fee: '0',
  dropoff_fee: '0',
  surcharge_pct: '0',
  airport_pickup_fee: '0',
  airport_dropoff_fee: '0',
  is_active: true,
  existing_id: null,
});

export function ZoneRoutePricingTab() {
  const [rules, setRules] = useState<ZoneRouteRule[]>([]);
  const [zones, setZones] = useState<Zone[]>([]);
  const [vehicleTypes, setVehicleTypes] = useState<VehicleType[]>([]);
  const [serviceAreas, setServiceAreas] = useState<ServiceArea[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Route header
  const [routeHeader, setRouteHeader] = useState({
    from_zone_id: '',
    to_zone_id: '',
    service_area_id: '',
    priority: '0',
  });
  const [matrix, setMatrix] = useState<MatrixRow[]>([]);

  const fetchAll = async () => {
    setLoading(true);
    const [rulesRes, zonesRes, vtRes, saRes] = await Promise.all([
      supabase.from('zone_route_pricing').select('*').order('priority', { ascending: false }),
      supabase.from('custom_zones').select('id, name').eq('zone_type', 'PRICING').eq('is_active', true),
      supabase.from('vehicle_types').select('id, name').eq('is_active', true).order('display_order'),
      supabase.from('service_areas').select('id, name').eq('is_active', true),
    ]);
    if (rulesRes.data) setRules(rulesRes.data as ZoneRouteRule[]);
    if (zonesRes.data) setZones(zonesRes.data as Zone[]);
    if (vtRes.data) setVehicleTypes(vtRes.data as VehicleType[]);
    if (saRes.data) setServiceAreas(saRes.data as ServiceArea[]);
    setLoading(false);
  };

  useEffect(() => { fetchAll(); }, []);

  // Group rules by route key (from→to×service_area)
  const grouped = useMemo(() => {
    const map = new Map<string, { from_zone_id: string; to_zone_id: string; service_area_id: string | null; rows: ZoneRouteRule[] }>();
    for (const r of rules) {
      const key = `${r.from_zone_id}::${r.to_zone_id}::${r.service_area_id ?? ''}`;
      if (!map.has(key)) {
        map.set(key, { from_zone_id: r.from_zone_id, to_zone_id: r.to_zone_id, service_area_id: r.service_area_id, rows: [] });
      }
      map.get(key)!.rows.push(r);
    }
    return Array.from(map.entries()).map(([key, val]) => ({ key, ...val }));
  }, [rules]);

  const openCreate = () => {
    setRouteHeader({ from_zone_id: '', to_zone_id: '', service_area_id: '', priority: '0' });
    // Initialize matrix with one row per active vehicle type + fallback
    setMatrix([
      ...vehicleTypes.map(vt => blankRow(vt.id)),
      blankRow(null),
    ]);
    setDialogOpen(true);
  };

  const openEditRoute = (group: typeof grouped[number]) => {
    setRouteHeader({
      from_zone_id: group.from_zone_id,
      to_zone_id: group.to_zone_id,
      service_area_id: group.service_area_id ?? '',
      priority: String(group.rows[0]?.priority ?? 0),
    });
    // Build matrix: one row per vehicle type + fallback, prefilled if existing
    const byVt = new Map(group.rows.map(r => [r.vehicle_type_id, r]));
    const next: MatrixRow[] = vehicleTypes.map(vt => {
      const existing = byVt.get(vt.id);
      if (existing) {
        return {
          vehicle_type_id: vt.id,
          fixed_fare: String(existing.fixed_fare),
          pickup_fee: String(existing.pickup_fee ?? 0),
          dropoff_fee: String(existing.dropoff_fee ?? 0),
          surcharge_pct: String(existing.surcharge_pct ?? 0),
          airport_pickup_fee: String(existing.airport_pickup_fee ?? 0),
          airport_dropoff_fee: String(existing.airport_dropoff_fee ?? 0),
          is_active: existing.is_active,
          existing_id: existing.id,
        };
      }
      return blankRow(vt.id);
    });
    const fallback = byVt.get(null);
    next.push(fallback ? {
      vehicle_type_id: null,
      fixed_fare: String(fallback.fixed_fare),
      pickup_fee: String(fallback.pickup_fee ?? 0),
      dropoff_fee: String(fallback.dropoff_fee ?? 0),
      surcharge_pct: String(fallback.surcharge_pct ?? 0),
      airport_pickup_fee: String(fallback.airport_pickup_fee ?? 0),
      airport_dropoff_fee: String(fallback.airport_dropoff_fee ?? 0),
      is_active: fallback.is_active,
      existing_id: fallback.id,
    } : blankRow(null));
    setDialogOpen(true);
  };

  const updateMatrixRow = (idx: number, patch: Partial<MatrixRow>) => {
    setMatrix(m => m.map((r, i) => i === idx ? { ...r, ...patch } : r));
  };

  const handleSave = async () => {
    if (!routeHeader.from_zone_id || !routeHeader.to_zone_id) {
      toast.error('From Zone and To Zone are required');
      return;
    }
    if (routeHeader.from_zone_id === routeHeader.to_zone_id) {
      toast.error('From Zone and To Zone must be different');
      return;
    }
    // Only persist rows where the admin entered a fixed_fare
    const filled = matrix.filter(r => r.fixed_fare !== '' && !isNaN(parseFloat(r.fixed_fare)));
    if (filled.length === 0) {
      toast.error('Enter at least one fixed fare for a vehicle category');
      return;
    }

    setSaving(true);
    try {
      // Delete rows that were cleared (had existing_id but now no fare)
      const toDelete = matrix.filter(r => r.existing_id && (r.fixed_fare === '' || isNaN(parseFloat(r.fixed_fare))));
      if (toDelete.length > 0) {
        const { error } = await supabase
          .from('zone_route_pricing')
          .delete()
          .in('id', toDelete.map(r => r.existing_id!));
        if (error) throw error;
      }

      // Upsert filled rows
      const payloads = filled.map(r => ({
        ...(r.existing_id ? { id: r.existing_id } : {}),
        from_zone_id: routeHeader.from_zone_id,
        to_zone_id: routeHeader.to_zone_id,
        service_area_id: routeHeader.service_area_id || null,
        vehicle_type_id: r.vehicle_type_id,
        fixed_fare: parseFloat(r.fixed_fare),
        pickup_fee: parseFloat(r.pickup_fee) || 0,
        dropoff_fee: parseFloat(r.dropoff_fee) || 0,
        surcharge_pct: parseFloat(r.surcharge_pct) || 0,
        airport_pickup_fee: parseFloat(r.airport_pickup_fee) || 0,
        airport_dropoff_fee: parseFloat(r.airport_dropoff_fee) || 0,
        is_active: r.is_active,
        priority: parseInt(routeHeader.priority) || 0,
      }));

      // Update + insert separately to keep simple semantics
      for (const p of payloads) {
        if ((p as any).id) {
          const { id, ...patch } = p as any;
          const { error } = await supabase.from('zone_route_pricing').update(patch).eq('id', id);
          if (error) throw error;
        } else {
          const { error } = await supabase.from('zone_route_pricing').insert(p as any);
          if (error) throw error;
        }
      }

      toast.success(`Saved ${payloads.length} pricing row${payloads.length === 1 ? '' : 's'}`);
      setDialogOpen(false);
      fetchAll();
    } catch (err: any) {
      toast.error(err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteRow = async (id: string) => {
    const { error } = await supabase.from('zone_route_pricing').delete().eq('id', id);
    if (error) toast.error(error.message);
    else { toast.success('Pricing row deleted'); fetchAll(); }
  };

  const handleDeleteRoute = async (group: typeof grouped[number]) => {
    if (!confirm(`Delete all ${group.rows.length} pricing rows for this route?`)) return;
    const { error } = await supabase
      .from('zone_route_pricing')
      .delete()
      .in('id', group.rows.map(r => r.id));
    if (error) toast.error(error.message);
    else { toast.success('Route deleted'); fetchAll(); }
  };

  const handleToggleRow = async (id: string, active: boolean) => {
    const { error } = await supabase.from('zone_route_pricing').update({ is_active: active }).eq('id', id);
    if (error) toast.error(error.message);
    else fetchAll();
  };

  const toggleExpand = (key: string) => {
    setExpanded(s => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key); else n.add(key);
      return n;
    });
  };

  const zoneName = (id: string) => zones.find(z => z.id === id)?.name || 'Unknown';
  const vehicleName = (id: string | null) => id ? vehicleTypes.find(v => v.id === id)?.name || 'Unknown' : 'Default (fallback)';
  const serviceAreaName = (id: string | null) => id ? serviceAreas.find(s => s.id === id)?.name || 'Unknown' : 'Any';

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <Button onClick={openCreate}>
          <Plus className="h-4 w-4 mr-2" /> Add Route
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Route className="h-5 w-5" /> Route Pricing — Per Vehicle Category</CardTitle>
          <CardDescription>
            Each route stores one independent fixed-fare row per vehicle category (ONECAB, Comfort, Premium, XL, etc.).
            A row labelled "Default (fallback)" applies only when no category-specific row exists.
            Direction matters: A→B is separate from B→A.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
          ) : grouped.length === 0 ? (
            <p className="text-center py-12 text-muted-foreground">No zone route pricing rules yet.</p>
          ) : (
            <div className="space-y-2">
              {grouped.map(group => {
                const open = expanded.has(group.key);
                const activeCount = group.rows.filter(r => r.is_active).length;
                return (
                  <Card key={group.key} className="border-border">
                    <div className="flex items-center justify-between p-3">
                      <button onClick={() => toggleExpand(group.key)} className="flex items-center gap-2 flex-1 text-left">
                        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        <span className="font-medium">{zoneName(group.from_zone_id)} → {zoneName(group.to_zone_id)}</span>
                        <Badge variant="outline">{serviceAreaName(group.service_area_id)}</Badge>
                        <Badge variant="secondary">{activeCount}/{group.rows.length} active</Badge>
                      </button>
                      <div className="flex gap-1">
                        <Button variant="ghost" size="sm" onClick={() => openEditRoute(group)}>
                          <Pencil className="h-4 w-4 mr-1" /> Edit Matrix
                        </Button>
                        <Button variant="ghost" size="icon" onClick={() => handleDeleteRoute(group)}>
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    </div>
                    {open && (
                      <div className="border-t border-border">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Vehicle Category</TableHead>
                              <TableHead>Fixed Fare</TableHead>
                              <TableHead>Pickup Fee</TableHead>
                              <TableHead>Dropoff Fee</TableHead>
                              <TableHead>Airport P/D</TableHead>
                              <TableHead>Surcharge %</TableHead>
                              <TableHead>Active</TableHead>
                              <TableHead className="text-right">Actions</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {group.rows.map(r => (
                              <TableRow key={r.id}>
                                <TableCell className="font-medium">
                                  {vehicleName(r.vehicle_type_id)}
                                  {r.vehicle_type_id === null && <Badge variant="outline" className="ml-2">fallback</Badge>}
                                </TableCell>
                                <TableCell>£{Number(r.fixed_fare).toFixed(2)}</TableCell>
                                <TableCell>£{Number(r.pickup_fee ?? 0).toFixed(2)}</TableCell>
                                <TableCell>£{Number(r.dropoff_fee ?? 0).toFixed(2)}</TableCell>
                                <TableCell>£{Number(r.airport_pickup_fee ?? 0).toFixed(2)} / £{Number(r.airport_dropoff_fee ?? 0).toFixed(2)}</TableCell>
                                <TableCell>{Number(r.surcharge_pct ?? 0).toFixed(1)}%</TableCell>
                                <TableCell>
                                  <Switch checked={r.is_active} onCheckedChange={(v) => handleToggleRow(r.id, v)} />
                                </TableCell>
                                <TableCell className="text-right">
                                  <Button variant="ghost" size="icon" onClick={() => handleDeleteRow(r.id)}>
                                    <Trash2 className="h-4 w-4 text-destructive" />
                                  </Button>
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    )}
                  </Card>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Matrix editor dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-5xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Route Pricing Matrix</DialogTitle>
            <DialogDescription>
              Set an independent fixed fare for each vehicle category. Leave a row blank to skip it — that category will fall through to the "Default (fallback)" row, or to standard meter pricing if no fallback is set.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>From Zone *</Label>
                <Select value={routeHeader.from_zone_id} onValueChange={v => setRouteHeader(h => ({ ...h, from_zone_id: v }))}>
                  <SelectTrigger><SelectValue placeholder="Select zone" /></SelectTrigger>
                  <SelectContent>{zones.map(z => <SelectItem key={z.id} value={z.id}>{z.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>To Zone *</Label>
                <Select value={routeHeader.to_zone_id} onValueChange={v => setRouteHeader(h => ({ ...h, to_zone_id: v }))}>
                  <SelectTrigger><SelectValue placeholder="Select zone" /></SelectTrigger>
                  <SelectContent>{zones.map(z => <SelectItem key={z.id} value={z.id}>{z.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Service Area (optional)</Label>
                <Select value={routeHeader.service_area_id || "__any__"} onValueChange={v => setRouteHeader(h => ({ ...h, service_area_id: v === "__any__" ? "" : v }))}>
                  <SelectTrigger><SelectValue placeholder="Any" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__any__">Any</SelectItem>
                    {serviceAreas.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Priority</Label>
                <Input type="number" min="0" placeholder="0" value={routeHeader.priority} onChange={e => setRouteHeader(h => ({ ...h, priority: e.target.value }))} />
              </div>
            </div>

            <div className="border border-border rounded-md overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="min-w-[140px]">Vehicle</TableHead>
                    <TableHead>Fixed Fare £</TableHead>
                    <TableHead>Pickup £</TableHead>
                    <TableHead>Dropoff £</TableHead>
                    <TableHead>Airport Pickup £</TableHead>
                    <TableHead>Airport Dropoff £</TableHead>
                    <TableHead>Surcharge %</TableHead>
                    <TableHead>Active</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {matrix.map((row, idx) => (
                    <TableRow key={`${row.vehicle_type_id ?? 'fallback'}-${idx}`}>
                      <TableCell className="font-medium whitespace-nowrap">
                        {vehicleName(row.vehicle_type_id)}
                        {row.vehicle_type_id === null && <Badge variant="outline" className="ml-2">fallback</Badge>}
                      </TableCell>
                      <TableCell>
                        <Input type="number" step="0.01" min="0" placeholder="—" className="w-24"
                          value={row.fixed_fare}
                          onChange={e => updateMatrixRow(idx, { fixed_fare: e.target.value })} />
                      </TableCell>
                      <TableCell>
                        <Input type="number" step="0.01" min="0" className="w-20"
                          value={row.pickup_fee}
                          onChange={e => updateMatrixRow(idx, { pickup_fee: e.target.value })} />
                      </TableCell>
                      <TableCell>
                        <Input type="number" step="0.01" min="0" className="w-20"
                          value={row.dropoff_fee}
                          onChange={e => updateMatrixRow(idx, { dropoff_fee: e.target.value })} />
                      </TableCell>
                      <TableCell>
                        <Input type="number" step="0.01" min="0" className="w-20"
                          value={row.airport_pickup_fee}
                          onChange={e => updateMatrixRow(idx, { airport_pickup_fee: e.target.value })} />
                      </TableCell>
                      <TableCell>
                        <Input type="number" step="0.01" min="0" className="w-20"
                          value={row.airport_dropoff_fee}
                          onChange={e => updateMatrixRow(idx, { airport_dropoff_fee: e.target.value })} />
                      </TableCell>
                      <TableCell>
                        <Input type="number" step="0.1" min="0" max="100" className="w-20"
                          value={row.surcharge_pct}
                          onChange={e => updateMatrixRow(idx, { surcharge_pct: e.target.value })} />
                      </TableCell>
                      <TableCell>
                        <Switch checked={row.is_active}
                          onCheckedChange={v => updateMatrixRow(idx, { is_active: v })} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <p className="text-xs text-muted-foreground">
              💡 Only rows with a fixed fare value are saved. Leave the fare blank to skip a category — the engine will use the fallback row, or standard meter pricing if no fallback is set.
            </p>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Save Matrix
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
