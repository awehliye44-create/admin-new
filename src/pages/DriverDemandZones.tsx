import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Plus, Pencil, Trash2, RefreshCw, Flame } from 'lucide-react';

type DemandLevel = 'LOW' | 'MEDIUM' | 'HIGH';
type DemandSource = 'manual' | 'computed';

interface DemandZone {
  id: string;
  name: string;
  center_lat: number;
  center_lng: number;
  radius_meters: number;
  demand_level: DemandLevel;
  active: boolean;
  region_id: string | null;
  service_area_id: string | null;
  source: DemandSource;
  created_at: string;
  updated_at: string;
  region?: { id: string; name: string } | null;
  service_area?: { id: string; name: string } | null;
}

interface Region {
  id: string;
  name: string;
}

interface ServiceArea {
  id: string;
  name: string;
  region_id: string;
}

const DEMAND_LEVELS: DemandLevel[] = ['LOW', 'MEDIUM', 'HIGH'];

const emptyForm = {
  name: '',
  center_lat: '',
  center_lng: '',
  radius_meters: '700',
  demand_level: 'MEDIUM' as DemandLevel,
  active: true,
  region_id: '',
  service_area_id: '',
};

export default function DriverDemandZones() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<DemandZone | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [sourceFilter, setSourceFilter] = useState<'all' | DemandSource>('all');
  const [search, setSearch] = useState('');

  const { data: zones = [], isLoading, refetch, isFetching } = useQuery({
    queryKey: ['driver-demand-zones'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('driver_demand_zones')
        .select('*, region:regions(id, name), service_area:service_areas(id, name)')
        .order('source')
        .order('name');
      if (error) throw error;
      return data as DemandZone[];
    },
  });

  const { data: regions = [] } = useQuery({
    queryKey: ['driver-demand-regions'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('regions')
        .select('id, name')
        .eq('status', 'active')
        .order('name');
      if (error) throw error;
      return data as Region[];
    },
  });

  const { data: serviceAreas = [] } = useQuery({
    queryKey: ['driver-demand-service-areas'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('service_areas')
        .select('id, name, region_id')
        .eq('is_active', true)
        .order('name');
      if (error) throw error;
      return data as ServiceArea[];
    },
  });

  const formServiceAreas = useMemo(
    () => serviceAreas.filter((sa) => !form.region_id || sa.region_id === form.region_id),
    [serviceAreas, form.region_id],
  );

  const filteredZones = useMemo(() => {
    const q = search.trim().toLowerCase();
    return zones.filter((zone) => {
      if (sourceFilter !== 'all' && zone.source !== sourceFilter) return false;
      if (!q) return true;
      return (
        zone.name.toLowerCase().includes(q)
        || zone.service_area?.name?.toLowerCase().includes(q)
        || zone.region?.name?.toLowerCase().includes(q)
      );
    });
  }, [zones, sourceFilter, search]);

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm);
    setDialogOpen(true);
  };

  const openEdit = (zone: DemandZone) => {
    if (zone.source === 'computed') {
      toast({
        title: 'Read-only zone',
        description: 'Computed zones are rebuilt automatically from open trips.',
        variant: 'destructive',
      });
      return;
    }
    setEditing(zone);
    setForm({
      name: zone.name,
      center_lat: String(zone.center_lat),
      center_lng: String(zone.center_lng),
      radius_meters: String(zone.radius_meters),
      demand_level: zone.demand_level,
      active: zone.active,
      region_id: zone.region_id ?? '',
      service_area_id: zone.service_area_id ?? '',
    });
    setDialogOpen(true);
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        name: form.name.trim(),
        center_lat: Number(form.center_lat),
        center_lng: Number(form.center_lng),
        radius_meters: Number(form.radius_meters),
        demand_level: form.demand_level,
        active: form.active,
        region_id: form.region_id || null,
        service_area_id: form.service_area_id || null,
        source: 'manual' as const,
      };

      if (!payload.name) throw new Error('Name is required');
      if (!Number.isFinite(payload.center_lat) || !Number.isFinite(payload.center_lng)) {
        throw new Error('Valid latitude and longitude are required');
      }
      if (!Number.isFinite(payload.radius_meters) || payload.radius_meters <= 0) {
        throw new Error('Radius must be greater than zero');
      }

      if (editing) {
        const { error } = await supabase
          .from('driver_demand_zones')
          .update(payload)
          .eq('id', editing.id);
        if (error) throw error;
        return;
      }

      const { error } = await supabase.from('driver_demand_zones').insert(payload);
      if (error) throw error;
    },
    onSuccess: async () => {
      toast({ title: editing ? 'Zone updated' : 'Zone created' });
      setDialogOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['driver-demand-zones'] });
    },
    onError: (err: Error) => {
      toast({ title: 'Save failed', description: err.message, variant: 'destructive' });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (zone: DemandZone) => {
      if (zone.source === 'computed') {
        throw new Error('Computed zones cannot be deleted manually');
      }
      const { error } = await supabase.from('driver_demand_zones').delete().eq('id', zone.id);
      if (error) throw error;
    },
    onSuccess: async () => {
      toast({ title: 'Zone deleted' });
      await queryClient.invalidateQueries({ queryKey: ['driver-demand-zones'] });
    },
    onError: (err: Error) => {
      toast({ title: 'Delete failed', description: err.message, variant: 'destructive' });
    },
  });

  const computeMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke('compute-driver-demand-zones', {
        body: { source: 'admin_manual' },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: async (data) => {
      toast({
        title: 'Computed demand refreshed',
        description: typeof data?.computed_zones_written === 'number'
          ? `${data.computed_zones_written} zone(s) written from ${data.open_trips_scanned ?? 0} open trip(s).`
          : 'Compute job finished.',
      });
      await queryClient.invalidateQueries({ queryKey: ['driver-demand-zones'] });
    },
    onError: (err: Error) => {
      toast({ title: 'Compute failed', description: err.message, variant: 'destructive' });
    },
  });

  const levelBadge = (level: DemandLevel) => {
    const variant = level === 'HIGH' ? 'destructive' : level === 'MEDIUM' ? 'default' : 'secondary';
    return <Badge variant={variant}>{level}</Badge>;
  };

  return (
    <AdminLayout
      title="Driver Demand Zones"
      description="Visual guidance for drivers on the map heatmap. Does not affect fares or dispatch."
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <Input
            placeholder="Search zones…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="max-w-xs"
          />
          <Select value={sourceFilter} onValueChange={(v) => setSourceFilter(v as typeof sourceFilter)}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Source" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All sources</SelectItem>
              <SelectItem value="manual">Manual</SelectItem>
              <SelectItem value="computed">Computed</SelectItem>
            </SelectContent>
          </Select>
          <div className="ml-auto flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => refetch()} disabled={isFetching}>
              {isFetching ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
              Refresh
            </Button>
            <Button
              variant="outline"
              onClick={() => computeMutation.mutate()}
              disabled={computeMutation.isPending}
            >
              {computeMutation.isPending
                ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                : <Flame className="mr-2 h-4 w-4" />}
              Recompute from trips
            </Button>
            <Button onClick={openCreate}>
              <Plus className="mr-2 h-4 w-4" />
              Add manual zone
            </Button>
          </div>
        </div>

        <div className="rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Level</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Service area</TableHead>
                <TableHead>Center</TableHead>
                <TableHead>Radius (m)</TableHead>
                <TableHead>Active</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={8} className="py-10 text-center text-muted-foreground">
                    <Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin" />
                    Loading zones…
                  </TableCell>
                </TableRow>
              ) : filteredZones.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="py-10 text-center text-muted-foreground">
                    No demand zones yet. Add manual zones or run compute from open trips.
                  </TableCell>
                </TableRow>
              ) : filteredZones.map((zone) => (
                <TableRow key={zone.id}>
                  <TableCell className="font-medium">{zone.name}</TableCell>
                  <TableCell>{levelBadge(zone.demand_level)}</TableCell>
                  <TableCell>
                    <Badge variant={zone.source === 'computed' ? 'outline' : 'secondary'}>
                      {zone.source}
                    </Badge>
                  </TableCell>
                  <TableCell>{zone.service_area?.name ?? 'Global'}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {zone.center_lat.toFixed(4)}, {zone.center_lng.toFixed(4)}
                  </TableCell>
                  <TableCell>{zone.radius_meters}</TableCell>
                  <TableCell>{zone.active ? 'Yes' : 'No'}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => openEdit(zone)}
                        disabled={zone.source === 'computed'}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => deleteMutation.mutate(zone)}
                        disabled={zone.source === 'computed' || deleteMutation.isPending}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit demand zone' : 'Add demand zone'}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid gap-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="lat">Latitude</Label>
                <Input
                  id="lat"
                  value={form.center_lat}
                  onChange={(e) => setForm((f) => ({ ...f, center_lat: e.target.value }))}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="lng">Longitude</Label>
                <Input
                  id="lng"
                  value={form.center_lng}
                  onChange={(e) => setForm((f) => ({ ...f, center_lng: e.target.value }))}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="radius">Radius (meters)</Label>
                <Input
                  id="radius"
                  value={form.radius_meters}
                  onChange={(e) => setForm((f) => ({ ...f, radius_meters: e.target.value }))}
                />
              </div>
              <div className="grid gap-2">
                <Label>Demand level</Label>
                <Select
                  value={form.demand_level}
                  onValueChange={(v) => setForm((f) => ({ ...f, demand_level: v as DemandLevel }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DEMAND_LEVELS.map((level) => (
                      <SelectItem key={level} value={level}>{level}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label>Region (optional)</Label>
                <Select
                  value={form.region_id || 'none'}
                  onValueChange={(v) => setForm((f) => ({
                    ...f,
                    region_id: v === 'none' ? '' : v,
                    service_area_id: '',
                  }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Global" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Global</SelectItem>
                    {regions.map((r) => (
                      <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label>Service area (optional)</Label>
                <Select
                  value={form.service_area_id || 'none'}
                  onValueChange={(v) => setForm((f) => ({
                    ...f,
                    service_area_id: v === 'none' ? '' : v,
                  }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Any in region" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Any / global</SelectItem>
                    {formServiceAreas.map((sa) => (
                      <SelectItem key={sa.id} value={sa.id}>{sa.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="active">Active</Label>
              <Switch
                id="active"
                checked={form.active}
                onCheckedChange={(checked) => setForm((f) => ({ ...f, active: checked }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
              {saveMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
}
