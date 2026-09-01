import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
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
import { Loader2, Plus, Pencil, Trash2, RefreshCw, Flame, Map, List, Settings2, History } from 'lucide-react';
import { DriverDemandZonesMap } from '@/components/maps/DriverDemandZonesMap';
import { DriverDemandZonesHelpPanel } from '@/components/dispatch/DriverDemandZonesHelpPanel';
import { DemandZoneSettingsDialog } from '@/components/dispatch/DemandZoneSettingsDialog';
import { DemandZoneAuditPanel } from '@/components/dispatch/DemandZoneAuditPanel';
import type { AdminDemandZone } from '@/lib/demandZoneGeojson';
import { buildPaletteByServiceArea } from '@/lib/demandZoneGeojson';
import { buildDemandZoneColorPalette } from '@/lib/demandZoneMapStyle';
import {
  DEMAND_ZONE_ACTION_KEYS,
  type DemandZoneSettings,
} from '../../shared/demandZoneSurgeSSOT';
import { useRoleCapabilities } from '@/hooks/useRoleCapabilities';

type DemandLevel = 'LOW' | 'MEDIUM' | 'HIGH';
type DemandSource = 'manual' | 'computed';
type ViewMode = 'map' | 'list' | 'audit';

interface DemandZone extends AdminDemandZone {
  region_id: string | null;
  service_area_id: string | null;
  source: DemandSource;
  proposed_demand_level: DemandLevel | null;
  confirmed_demand_level: DemandLevel | null;
  last_open_trip_count: number | null;
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
  geo_boundary: GeoJSON.Polygon | null;
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

function parseGeoBoundary(raw: unknown): GeoJSON.Polygon | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as { type?: string; coordinates?: unknown };
  if (obj.type === 'Polygon' && Array.isArray(obj.coordinates)) {
    return obj as GeoJSON.Polygon;
  }
  return null;
}

export default function DriverDemandZones() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { actor, has: hasAction, isLoading: capsLoading } = useRoleCapabilities();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<DemandZone | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [viewMode, setViewMode] = useState<ViewMode>('map');
  const [regionFilter, setRegionFilter] = useState('all');
  const [serviceAreaFilter, setServiceAreaFilter] = useState('all');
  const [sourceFilter, setSourceFilter] = useState<'all' | DemandSource>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('active');
  const [search, setSearch] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(null);


  const { data: zones = [], isLoading, refetch, isFetching } = useQuery({
    queryKey: ['driver-demand-zones'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('driver_demand_zones')
        .select('id, name, center_lat, center_lng, radius_meters, demand_level, proposed_demand_level, confirmed_demand_level, last_open_trip_count, active, region_id, service_area_id, source, created_at, updated_at, region:regions(id, name), service_area:service_areas(id, name)')
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
        .select('id, name, region_id, geo_boundary')
        .eq('is_active', true)
        .order('name');
      if (error) throw error;
      return (data ?? []).map((row) => ({
        ...row,
        geo_boundary: parseGeoBoundary(row.geo_boundary),
      })) as ServiceArea[];
    },
  });

  const { data: allDemandSettings = [] } = useQuery({
    queryKey: ['demand-zone-settings-all'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('service_area_demand_zone_settings')
        .select('service_area_id, heat_map_enabled, manual_zones_enabled, recompute_interval_minutes, open_trip_max_lifetime_minutes, low_min_trips, low_max_trips, medium_min_trips, medium_max_trips, high_min_trips, consecutive_checks_required, surge_enabled, multiplier_low, multiplier_medium, multiplier_high, colour_low, colour_medium, colour_high');
      if (error) throw error;
      return (data ?? []) as DemandZoneSettings[];
    },
  });

  const selectedSettings = useMemo(() => {
    if (serviceAreaFilter === 'all') return null;
    return allDemandSettings.find((s) => s.service_area_id === serviceAreaFilter) ?? null;
  }, [allDemandSettings, serviceAreaFilter]);

  const mapGeoJsonOptions = useMemo(() => {
    if (serviceAreaFilter !== 'all' && selectedSettings) {
      return { palette: buildDemandZoneColorPalette(selectedSettings) };
    }
    return { paletteByServiceArea: buildPaletteByServiceArea(allDemandSettings) };
  }, [serviceAreaFilter, selectedSettings, allDemandSettings]);

  const mapLegendPalette = useMemo(
    () => (selectedSettings ? buildDemandZoneColorPalette(selectedSettings) : undefined),
    [selectedSettings],
  );

  const manualZonesEnabled = serviceAreaFilter === 'all'
    ? allDemandSettings.some((s) => s.manual_zones_enabled)
    : (selectedSettings?.manual_zones_enabled ?? true);

  const heatMapEnabled = serviceAreaFilter === 'all'
    ? allDemandSettings.some((s) => s.heat_map_enabled)
    : (selectedSettings?.heat_map_enabled ?? true);

  const recomputeIntervalLabel = selectedSettings?.recompute_interval_minutes
    ?? allDemandSettings.find((s) => s.heat_map_enabled)?.recompute_interval_minutes
    ?? 2;

  const displayLevel = (zone: DemandZone): DemandLevel =>
    zone.confirmed_demand_level ?? zone.demand_level;

  const filterServiceAreas = useMemo(
    () => (regionFilter === 'all'
      ? serviceAreas
      : serviceAreas.filter((sa) => sa.region_id === regionFilter)),
    [serviceAreas, regionFilter],
  );

  const formServiceAreas = useMemo(
    () => serviceAreas.filter((sa) => !form.region_id || sa.region_id === form.region_id),
    [serviceAreas, form.region_id],
  );

  const filteredZones = useMemo(() => {
    const q = search.trim().toLowerCase();
    return zones.filter((zone) => {
      if (regionFilter !== 'all' && zone.region_id !== regionFilter) return false;
      if (serviceAreaFilter !== 'all' && zone.service_area_id !== serviceAreaFilter) return false;
      if (sourceFilter !== 'all' && zone.source !== sourceFilter) return false;
      if (statusFilter === 'active' && !zone.active) return false;
      if (statusFilter === 'inactive' && zone.active) return false;
      if (!q) return true;
      return (
        zone.name.toLowerCase().includes(q)
        || zone.service_area?.name?.toLowerCase().includes(q)
        || zone.region?.name?.toLowerCase().includes(q)
      );
    });
  }, [zones, regionFilter, serviceAreaFilter, sourceFilter, statusFilter, search]);

  const mapZones = useMemo(
    () => filteredZones.filter((z) => z.active),
    [filteredZones],
  );

  const serviceAreaBoundary = useMemo(() => {
    if (serviceAreaFilter === 'all') return null;
    return filterServiceAreas.find((sa) => sa.id === serviceAreaFilter)?.geo_boundary ?? null;
  }, [serviceAreaFilter, filterServiceAreas]);

  const canRecompute = actor.isSuperAdmin || hasAction(DEMAND_ZONE_ACTION_KEYS.recompute);
  const canViewAudit = actor.isSuperAdmin || hasAction(DEMAND_ZONE_ACTION_KEYS.viewAudit);
  const canManageManualZones =
    actor.isSuperAdmin
    || hasAction(DEMAND_ZONE_ACTION_KEYS.configureHeatMap);

  const selectedZone = useMemo(
    () => (selectedZoneId ? zones.find((z) => z.id === selectedZoneId) ?? null : null),
    [zones, selectedZoneId],
  );

  const surgeMultiplierForLevel = (level: DemandLevel): string | null => {
    if (!selectedSettings?.surge_enabled) return null;
    if (level === 'HIGH' && selectedSettings.multiplier_high != null) {
      return `×${selectedSettings.multiplier_high}`;
    }
    if (level === 'MEDIUM' && selectedSettings.multiplier_medium != null) {
      return `×${selectedSettings.multiplier_medium}`;
    }
    return `×${selectedSettings.multiplier_low ?? 1}`;
  };

  const openCreate = () => {
    if (!canManageManualZones) {
      toast({
        title: 'Permission required',
        description: 'You do not have permission to add manual demand zones.',
        variant: 'destructive',
      });
      return;
    }
    if (!manualZonesEnabled) {
      toast({
        title: 'Manual zones disabled',
        description: 'Enable manual zones in Heat map & surge settings for this service area.',
        variant: 'destructive',
      });
      return;
    }
    setEditing(null);
    setForm(emptyForm);
    setDialogOpen(true);
  };

  const openEdit = (zone: DemandZone) => {
    if (!canManageManualZones) {
      toast({
        title: 'Permission required',
        description: 'You do not have permission to edit manual demand zones.',
        variant: 'destructive',
      });
      return;
    }
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
      const body: Record<string, string> = { source: 'admin_manual' };
      if (serviceAreaFilter !== 'all') {
        body.service_area_id = serviceAreaFilter;
      }
      const { data, error } = await supabase.functions.invoke('compute-driver-demand-zones', {
        body,
      });
      if (error) throw error;
      if (data?.error) throw new Error(String(data.error));
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
      await queryClient.invalidateQueries({ queryKey: ['demand-zone-audit'] });
    },
    onError: (err: Error) => {
      toast({ title: 'Compute failed', description: err.message, variant: 'destructive' });
    },
  });

  const levelBadge = (level: DemandLevel) => {
    const variant = level === 'HIGH' ? 'destructive' : level === 'MEDIUM' ? 'default' : 'secondary';
    return <Badge variant={variant}>{level}</Badge>;
  };

  const zonesTable = (
    <div className="rounded-lg border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Level</TableHead>
            <TableHead>Confirmed</TableHead>
            <TableHead>Open trips</TableHead>
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
              <TableCell colSpan={10} className="py-10 text-center text-muted-foreground">
                <Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin" />
                Loading zones…
              </TableCell>
            </TableRow>
          ) : filteredZones.length === 0 ? (
            <TableRow>
              <TableCell colSpan={10} className="py-10 text-center text-muted-foreground">
                No demand zones match the current filters.
              </TableCell>
            </TableRow>
          ) : filteredZones.map((zone) => (
            <TableRow key={zone.id}>
              <TableCell className="font-medium">{zone.name}</TableCell>
              <TableCell>{levelBadge(displayLevel(zone))}</TableCell>
              <TableCell>
                {zone.source === 'computed' && zone.proposed_demand_level
                  && zone.proposed_demand_level !== zone.confirmed_demand_level ? (
                    <span className="text-xs text-muted-foreground">
                      {zone.confirmed_demand_level ?? '—'}
                      {' → '}
                      {zone.proposed_demand_level}
                    </span>
                  ) : (
                    levelBadge(zone.confirmed_demand_level ?? zone.demand_level)
                  )}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {zone.source === 'computed' && zone.last_open_trip_count != null
                  ? zone.last_open_trip_count
                  : '—'}
              </TableCell>
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
                    disabled={zone.source === 'computed' || !canManageManualZones}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => deleteMutation.mutate(zone)}
                    disabled={zone.source === 'computed' || deleteMutation.isPending || !canManageManualZones}
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
  );

  return (
    <AdminLayout
      title="Driver Demand Zones"
      description="Visual guidance for drivers. Zones show areas of expected demand based on live trip activity."
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <Select
            value={regionFilter}
            onValueChange={(v) => {
              setRegionFilter(v);
              setServiceAreaFilter('all');
            }}
          >
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="Region" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All regions</SelectItem>
              {regions.map((r) => (
                <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={serviceAreaFilter} onValueChange={setServiceAreaFilter}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Service area" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All service areas</SelectItem>
              {filterServiceAreas.map((sa) => (
                <SelectItem key={sa.id} value={sa.id}>{sa.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Input
            placeholder="Search zones…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="max-w-[200px]"
          />

          <Select value={sourceFilter} onValueChange={(v) => setSourceFilter(v as typeof sourceFilter)}>
            <SelectTrigger className="w-[150px]">
              <SelectValue placeholder="Source" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All sources</SelectItem>
              <SelectItem value="manual">Manual</SelectItem>
              <SelectItem value="computed">Computed</SelectItem>
            </SelectContent>
          </Select>

          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as typeof statusFilter)}>
            <SelectTrigger className="w-[130px]">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All status</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="inactive">Inactive</SelectItem>
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
              disabled={computeMutation.isPending || !heatMapEnabled || !canRecompute || capsLoading}
              title={
                !canRecompute
                  ? 'You do not have permission to recompute demand zones'
                  : !heatMapEnabled
                    ? 'Enable heat map in settings for this service area first'
                    : undefined
              }
            >
              {computeMutation.isPending
                ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                : <Flame className="mr-2 h-4 w-4" />}
              Recompute from trips
            </Button>
            <Button variant="outline" onClick={() => setSettingsOpen(true)}>
              <Settings2 className="mr-2 h-4 w-4" />
              Heat map &amp; surge settings
            </Button>
            <Button onClick={openCreate} disabled={!manualZonesEnabled || !canManageManualZones}>
              <Plus className="mr-2 h-4 w-4" />
              Add manual zone
            </Button>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3">
          <Tabs value={viewMode} onValueChange={(v) => setViewMode(v as ViewMode)}>
            <TabsList>
              <TabsTrigger value="map" className="gap-2">
                <Map className="h-4 w-4" />
                Map
              </TabsTrigger>
              <TabsTrigger value="list" className="gap-2">
                <List className="h-4 w-4" />
                List
              </TabsTrigger>
              {canViewAudit && (
                <TabsTrigger value="audit" className="gap-2">
                  <History className="h-4 w-4" />
                  Audit
                </TabsTrigger>
              )}
            </TabsList>
          </Tabs>
          <p className="text-xs text-muted-foreground">
            {filteredZones.length} zone{filteredZones.length === 1 ? '' : 's'}
            {' · '}
            {heatMapEnabled
              ? `Computed zones refresh every ${recomputeIntervalLabel} minute${recomputeIntervalLabel === 1 ? '' : 's'} from open trips`
              : 'Heat map disabled for the selected service area'}
          </p>
        </div>

        {viewMode === 'map' ? (
          <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
            <div className="relative min-w-0">
              <DriverDemandZonesMap
                zones={mapZones}
                serviceAreaBoundary={serviceAreaBoundary}
                geoJsonOptions={mapGeoJsonOptions}
                legendPalette={mapLegendPalette}
                onZoneClick={setSelectedZoneId}
              />
              {selectedZone && (
                <div className="absolute top-3 right-3 z-[2] max-w-[280px] rounded-lg border bg-background/95 p-3 text-sm shadow-md backdrop-blur-sm">
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-semibold leading-tight">{selectedZone.name}</p>
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground text-xs"
                      onClick={() => setSelectedZoneId(null)}
                      aria-label="Close zone details"
                    >
                      ✕
                    </button>
                  </div>
                  <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                    <p>
                      Confirmed:{' '}
                      <span className="font-medium text-foreground">
                        {displayLevel(selectedZone)}
                      </span>
                      {surgeMultiplierForLevel(displayLevel(selectedZone)) && (
                        <span className="ml-1 text-amber-700 dark:text-amber-400">
                          {surgeMultiplierForLevel(displayLevel(selectedZone))} surge
                        </span>
                      )}
                    </p>
                    {selectedZone.source === 'computed' && selectedZone.proposed_demand_level
                      && selectedZone.proposed_demand_level !== selectedZone.confirmed_demand_level && (
                      <p>
                        Pending:{' '}
                        <span className="font-medium text-foreground">
                          {selectedZone.proposed_demand_level}
                        </span>
                        {' (hysteresis)'}
                      </p>
                    )}
                    {selectedZone.source === 'computed' && selectedZone.last_open_trip_count != null && (
                      <p>Open trips: {selectedZone.last_open_trip_count}</p>
                    )}
                    <p>Source: {selectedZone.source}</p>
                    <p>{selectedZone.service_area?.name ?? 'Global'}</p>
                  </div>
                </div>
              )}
            </div>
            <DriverDemandZonesHelpPanel settings={selectedSettings} />
          </div>
        ) : viewMode === 'list' ? (
          <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
            <div className="min-w-0">{zonesTable}</div>
            <DriverDemandZonesHelpPanel settings={selectedSettings} />
          </div>
        ) : (
          <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
            <DemandZoneAuditPanel serviceAreaId={serviceAreaFilter} />
            <DriverDemandZonesHelpPanel settings={selectedSettings} />
          </div>
        )}
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

      <DemandZoneSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        serviceAreaId={serviceAreaFilter}
        serviceAreaName={
          filterServiceAreas.find((sa) => sa.id === serviceAreaFilter)?.name ?? 'All service areas'
        }
      />
    </AdminLayout>
  );
}
