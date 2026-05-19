import { useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { AdminLayout } from "@/components/layout/AdminLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { ZoneBoundaryMap } from "@/components/maps/ZoneBoundaryMap";
import { ZoneRoutePricingTab } from "@/components/pricing/ZoneRoutePricingTab";
import { 
  Plus, Edit, Trash2, Target, Search, 
  Map, DollarSign, RefreshCw, Loader2, Circle, Hexagon, Route
} from "lucide-react";

interface ZoneMetadata {
  airport_charge?: number;
  surcharge_pct?: number;
  fare_override_mode?: 'NONE' | 'FIXED_FARE' | 'MULTIPLIER';
  fare_override_value?: number;
  notes?: string;
}

interface CustomZone {
  id: string;
  name: string;
  description: string | null;
  zone_type: string;
  shape_type: 'polygon' | 'circle';
  region_id: string | null;
  service_area_id: string | null;
  geo_boundary: any;
  center_lat: number | null;
  center_lng: number | null;
  radius_meters: number | null;
  is_active: boolean;
  color: string | null;
  priority: number | null;
  metadata: ZoneMetadata;
  created_at: string;
  updated_at: string;
  region?: { id: string; name: string };
  service_area?: { id: string; name: string; geo_boundary: any };
}

interface Region {
  id: string;
  name: string;
  geo_boundary: any;
}

interface ServiceArea {
  id: string;
  name: string;
  region_id: string;
  geo_boundary: any;
  is_active: boolean;
}

const PRESET_COLORS = [
  '#EF4444', '#F97316', '#F59E0B', '#84CC16', '#22C55E',
  '#14B8A6', '#06B6D4', '#3B82F6', '#6366F1', '#8B5CF6',
  '#A855F7', '#D946EF', '#EC4899', '#F43F5E',
];

export default function CustomZones() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingZone, setEditingZone] = useState<CustomZone | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [regionFilter, setRegionFilter] = useState<string>("all");
  const [serviceAreaFilter, setServiceAreaFilter] = useState<string>("all");

  const [formData, setFormData] = useState({
    name: "",
    description: "",
    shape_type: "polygon" as 'polygon' | 'circle',
    region_id: "",
    service_area_id: "",
    color: "#3B82F6",
    priority: 0,
    is_active: true,
    geo_boundary: null as any,
    center_lat: null as number | null,
    center_lng: null as number | null,
    radius_meters: 500 as number | null,
    metadata: {} as ZoneMetadata,
  });

  // Fetch zones (PRICING only)
  const { data: zones = [], isLoading, refetch } = useQuery({
    queryKey: ['custom-zones-pricing'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('custom_zones')
        .select('*, region:regions(id, name), service_area:service_areas(id, name, geo_boundary)')
        .eq('zone_type', 'PRICING')
        .order('priority', { ascending: false });
      if (error) throw error;
      return data as CustomZone[];
    },
  });

  const { data: regions = [] } = useQuery({
    queryKey: ['regions-for-zones'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('regions')
        .select('id, name, geo_boundary')
        .eq('status', 'active')
        .order('name');
      if (error) throw error;
      return data as Region[];
    },
  });

  const { data: serviceAreas = [] } = useQuery({
    queryKey: ['service-areas-for-zones', regionFilter],
    queryFn: async () => {
      let query = supabase
        .from('service_areas')
        .select('id, name, region_id, geo_boundary, is_active')
        .eq('is_active', true)
        .order('name');
      if (regionFilter && regionFilter !== 'all') {
        query = query.eq('region_id', regionFilter);
      }
      const { data, error } = await query;
      if (error) throw error;
      return data as ServiceArea[];
    },
  });

  const formServiceAreas = serviceAreas.filter(sa => 
    !formData.region_id || sa.region_id === formData.region_id
  );

  const createMutation = useMutation({
    mutationFn: async (data: typeof formData) => {
      const { error } = await supabase.from('custom_zones').insert({
        name: data.name,
        description: data.description || null,
        zone_type: 'PRICING',
        shape_type: data.shape_type,
        region_id: data.region_id || null,
        service_area_id: data.service_area_id || null,
        color: data.color,
        priority: data.priority,
        is_active: data.is_active,
        geo_boundary: data.shape_type === 'polygon' ? data.geo_boundary : null,
        center_lat: data.shape_type === 'circle' ? data.center_lat : null,
        center_lng: data.shape_type === 'circle' ? data.center_lng : null,
        radius_meters: data.shape_type === 'circle' ? data.radius_meters : null,
        metadata: data.metadata as any,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['custom-zones-pricing'] });
      toast({ title: "Zone created successfully" });
      resetForm();
    },
    onError: (error: any) => {
      toast({ title: "Failed to create zone", description: error.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: typeof formData }) => {
      const { error } = await supabase.from('custom_zones').update({
        name: data.name,
        description: data.description || null,
        zone_type: 'PRICING',
        shape_type: data.shape_type,
        region_id: data.region_id || null,
        service_area_id: data.service_area_id || null,
        color: data.color,
        priority: data.priority,
        is_active: data.is_active,
        geo_boundary: data.shape_type === 'polygon' ? data.geo_boundary : null,
        center_lat: data.shape_type === 'circle' ? data.center_lat : null,
        center_lng: data.shape_type === 'circle' ? data.center_lng : null,
        radius_meters: data.shape_type === 'circle' ? data.radius_meters : null,
        metadata: data.metadata as any,
      }).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['custom-zones-pricing'] });
      toast({ title: "Zone updated successfully" });
      resetForm();
    },
    onError: (error: any) => {
      toast({ title: "Failed to update zone", description: error.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('custom_zones').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['custom-zones-pricing'] });
      toast({ title: "Zone deleted successfully" });
    },
    onError: (error: any) => {
      toast({ title: "Failed to delete zone", description: error.message, variant: "destructive" });
    },
  });

  const toggleStatusMutation = useMutation({
    mutationFn: async ({ id, is_active }: { id: string; is_active: boolean }) => {
      const { error } = await supabase.from('custom_zones').update({ is_active }).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['custom-zones-pricing'] });
      toast({ title: "Zone status updated" });
    },
  });

  const handlePolygonChange = useCallback((boundary: any) => {
    setFormData(prev => ({ ...prev, geo_boundary: boundary, center_lat: null, center_lng: null, radius_meters: null }));
  }, []);

  const handleCircleChange = useCallback((center_lat: number | null, center_lng: number | null, radius_meters: number | null) => {
    setFormData(prev => ({ ...prev, center_lat, center_lng, radius_meters, geo_boundary: null }));
  }, []);

  const handleShapeTypeChange = useCallback((type: 'polygon' | 'circle') => {
    setFormData(prev => ({ ...prev, shape_type: type, geo_boundary: null, center_lat: null, center_lng: null, radius_meters: 500 }));
  }, []);

  const getSelectedServiceArea = useCallback(() => {
    if (!formData.service_area_id) return null;
    return serviceAreas.find(sa => sa.id === formData.service_area_id) || null;
  }, [formData.service_area_id, serviceAreas]);

  const resetForm = () => {
    setFormData({
      name: "", description: "", shape_type: "polygon", region_id: "", service_area_id: "",
      color: "#3B82F6", priority: 0, is_active: true, geo_boundary: null,
      center_lat: null, center_lng: null, radius_meters: 500, metadata: {},
    });
    setEditingZone(null);
    setIsDialogOpen(false);
  };

  const handleEdit = (zone: CustomZone) => {
    setEditingZone(zone);
    setFormData({
      name: zone.name, description: zone.description || "", shape_type: zone.shape_type,
      region_id: zone.region_id || "", service_area_id: zone.service_area_id || "",
      color: zone.color || "#3B82F6", priority: zone.priority || 0, is_active: zone.is_active,
      geo_boundary: zone.geo_boundary, center_lat: zone.center_lat,
      center_lng: zone.center_lng, radius_meters: zone.radius_meters || 500,
      metadata: zone.metadata || {},
    });
    setIsDialogOpen(true);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (formData.shape_type === 'polygon' && !formData.geo_boundary) {
      toast({ title: "Please draw a polygon on the map", variant: "destructive" });
      return;
    }
    if (formData.shape_type === 'circle' && (!formData.center_lat || !formData.center_lng)) {
      toast({ title: "Please draw a circle on the map", variant: "destructive" });
      return;
    }
    if (editingZone) {
      updateMutation.mutate({ id: editingZone.id, data: formData });
    } else {
      createMutation.mutate(formData);
    }
  };

  const openCreateDialog = () => {
    setEditingZone(null);
    setFormData(prev => ({ ...prev, name: "", description: "", geo_boundary: null, center_lat: null, center_lng: null, metadata: {} }));
    setIsDialogOpen(true);
  };

  const getRegionName = (regionId: string | null) => {
    if (!regionId) return "—";
    return regions.find(r => r.id === regionId)?.name || "Unknown";
  };

  const getServiceAreaName = (zone: CustomZone) => {
    if (zone.service_area?.name) return zone.service_area.name;
    if (!zone.service_area_id) return "—";
    return serviceAreas.find(s => s.id === zone.service_area_id)?.name || "Unknown";
  };

  const filteredZones = zones.filter(zone => {
    const matchesSearch = zone.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (zone.description?.toLowerCase().includes(searchQuery.toLowerCase()));
    const matchesStatus = statusFilter === "all" || 
      (statusFilter === "active" && zone.is_active) ||
      (statusFilter === "inactive" && !zone.is_active);
    const matchesRegion = regionFilter === "all" || zone.region_id === regionFilter;
    const matchesServiceArea = serviceAreaFilter === "all" || zone.service_area_id === serviceAreaFilter;
    return matchesSearch && matchesStatus && matchesRegion && matchesServiceArea;
  });

  const activeCount = zones.filter(z => z.is_active).length;

  const formatOverride = (meta: ZoneMetadata) => {
    const mode = meta.fare_override_mode;
    if (!mode || mode === 'NONE') return null;
    if (mode === 'FIXED_FARE') return `Fixed £${meta.fare_override_value ?? 0}`;
    if (mode === 'MULTIPLIER') return `×${meta.fare_override_value ?? 1}`;
    return null;
  };

  return (
    <AdminLayout title="Custom Zones (Pricing)">
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Custom Zones (Pricing)</h1>
            <p className="text-muted-foreground">
              Create pricing zones that add pickup/dropoff fees or override fares based on location.
            </p>
          </div>
        </div>

        <Tabs defaultValue="zones" className="w-full">
          <TabsList>
            <TabsTrigger value="zones"><DollarSign className="h-4 w-4 mr-2" />Pricing Zones</TabsTrigger>
            <TabsTrigger value="routes"><Route className="h-4 w-4 mr-2" />Route Pricing</TabsTrigger>
          </TabsList>

          <TabsContent value="zones" className="space-y-6 mt-4">
        <div className="flex items-center justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              <RefreshCw className="h-4 w-4 mr-2" />
              Refresh
            </Button>
            <Button onClick={openCreateDialog}>
              <Plus className="mr-2 h-4 w-4" />
              Add Pricing Zone
            </Button>
        </div>

        {/* Stats */}
        <div className="grid gap-4 md:grid-cols-3">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Total Zones</CardTitle>
              <DollarSign className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{zones.length}</div>
              <p className="text-xs text-muted-foreground">{activeCount} active</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Service Areas</CardTitle>
              <Target className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{serviceAreas.length}</div>
              <p className="text-xs text-muted-foreground">available</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Regions</CardTitle>
              <Map className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{regions.length}</div>
              <p className="text-xs text-muted-foreground">with zone support</p>
            </CardContent>
          </Card>
        </div>

        {/* Zone Table */}
        <Card>
          <CardHeader>
            <CardTitle>Pricing Zones</CardTitle>
            <CardDescription>
              Zone pricing modifiers, airport fees, surcharges &amp; fare overrides
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {/* Filters */}
              <div className="flex flex-col gap-4 md:flex-row md:items-center flex-wrap">
                <div className="relative flex-1 min-w-[200px]">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input placeholder="Search zones..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="pl-10" />
                </div>
                <Select value={regionFilter} onValueChange={setRegionFilter}>
                  <SelectTrigger className="w-[160px]"><Map className="mr-2 h-4 w-4" /><SelectValue placeholder="Region" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Regions</SelectItem>
                    {regions.map((r) => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Select value={serviceAreaFilter} onValueChange={setServiceAreaFilter}>
                  <SelectTrigger className="w-[180px]"><Target className="mr-2 h-4 w-4" /><SelectValue placeholder="Service Area" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Service Areas</SelectItem>
                    {serviceAreas.map((sa) => <SelectItem key={sa.id} value={sa.id}>{sa.name}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger className="w-[130px]"><SelectValue placeholder="Status" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Status</SelectItem>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="inactive">Inactive</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Table */}
              {isLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin text-primary" />
                </div>
              ) : filteredZones.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <DollarSign className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p>No pricing zones found</p>
                  <p className="text-sm mt-1">Create a zone to get started</p>
                </div>
              ) : (
                <div className="rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Zone</TableHead>
                        <TableHead>Service Area</TableHead>
                        <TableHead>Shape</TableHead>
                        <TableHead>Priority</TableHead>
                        <TableHead>Airport Charge</TableHead>
                        <TableHead>Surcharge %</TableHead>
                        <TableHead>Override</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredZones.map((zone) => (
                        <TableRow key={zone.id}>
                          <TableCell>
                            <div className="flex items-center gap-3">
                              <div className="h-4 w-4 rounded-full shrink-0" style={{ backgroundColor: zone.color || '#3B82F6' }} />
                              <div>
                                <p className="font-medium">{zone.name}</p>
                                {zone.description && <p className="text-xs text-muted-foreground truncate max-w-[180px]">{zone.description}</p>}
                              </div>
                            </div>
                          </TableCell>
                          <TableCell>
                            <div>
                              <p className="text-sm">{getServiceAreaName(zone)}</p>
                              <p className="text-xs text-muted-foreground">{getRegionName(zone.region_id)}</p>
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className="gap-1">
                              {zone.shape_type === 'polygon' ? <Hexagon className="h-3 w-3" /> : <Circle className="h-3 w-3" />}
                              {zone.shape_type}
                            </Badge>
                          </TableCell>
                          <TableCell>{zone.priority || 0}</TableCell>
                          <TableCell>
                            {zone.metadata?.airport_charge
                              ? <span>£{zone.metadata.airport_charge}</span>
                              : <span className="text-muted-foreground">—</span>}
                          </TableCell>
                          <TableCell>
                            {zone.metadata?.surcharge_pct ? <span>{zone.metadata.surcharge_pct}%</span> : <span className="text-muted-foreground">—</span>}
                          </TableCell>
                          <TableCell>
                            {formatOverride(zone.metadata) ? (
                              <Badge variant="secondary" className="text-xs">{formatOverride(zone.metadata)}</Badge>
                            ) : <span className="text-muted-foreground text-sm">None</span>}
                          </TableCell>
                          <TableCell>
                            <Switch checked={zone.is_active} onCheckedChange={(checked) => toggleStatusMutation.mutate({ id: zone.id, is_active: checked })} />
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex items-center justify-end gap-2">
                              <Button variant="ghost" size="icon" onClick={() => handleEdit(zone)}><Edit className="h-4 w-4" /></Button>
                              <Button variant="ghost" size="icon" className="text-destructive hover:text-destructive" onClick={() => deleteMutation.mutate(zone.id)}><Trash2 className="h-4 w-4" /></Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Create/Edit Dialog */}
        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <form onSubmit={handleSubmit}>
              <DialogHeader>
                <DialogTitle>{editingZone ? "Edit Pricing Zone" : "Create Pricing Zone"}</DialogTitle>
                <DialogDescription>Apply fees, surcharges, or fare overrides based on location.</DialogDescription>
              </DialogHeader>

              <div className="grid gap-4 py-4">
                {/* Basic Info */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="grid gap-2">
                    <Label htmlFor="name">Zone Name *</Label>
                    <Input id="name" value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })} placeholder="e.g., Airport Terminal 1" required />
                  </div>
                  <div className="grid gap-2">
                    <Label>Region</Label>
                    <Select value={formData.region_id || "none"} onValueChange={(value) => setFormData({ ...formData, region_id: value === "none" ? "" : value, service_area_id: "" })}>
                      <SelectTrigger><SelectValue placeholder="Select Region" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">Select a region</SelectItem>
                        {regions.map((r) => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="grid gap-2">
                  <Label>Service Area *</Label>
                  <Select value={formData.service_area_id || "none"} onValueChange={(value) => setFormData({ ...formData, service_area_id: value === "none" ? "" : value })}>
                    <SelectTrigger><SelectValue placeholder="Select Service Area" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Select a service area</SelectItem>
                      {formServiceAreas.map((sa) => <SelectItem key={sa.id} value={sa.id}>{sa.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="description">Description</Label>
                  <Textarea id="description" value={formData.description} onChange={(e) => setFormData({ ...formData, description: e.target.value })} placeholder="Describe this zone..." rows={2} />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="grid gap-2">
                    <Label>Priority</Label>
                    <Input type="number" value={formData.priority} onChange={(e) => setFormData({ ...formData, priority: parseInt(e.target.value) || 0 })} min={0} max={100} />
                    <p className="text-xs text-muted-foreground">Higher priority wins when zones overlap</p>
                  </div>
                  <div className="grid gap-2">
                    <Label>Color</Label>
                    <div className="flex flex-wrap gap-1">
                      {PRESET_COLORS.slice(0, 7).map((c) => (
                        <button key={c} type="button" className={`h-6 w-6 rounded-full border-2 transition-transform ${formData.color === c ? 'border-foreground scale-110' : 'border-transparent'}`} style={{ backgroundColor: c }} onClick={() => setFormData({ ...formData, color: c })} />
                      ))}
                    </div>
                  </div>
                </div>

                <Separator />

                {/* Map */}
                <div className="space-y-3">
                  <Label className="text-base font-medium">Zone Boundary *</Label>
                  {!formData.service_area_id ? (
                    <div className="flex items-center gap-2 p-4 rounded-lg border border-dashed border-muted-foreground/30 bg-muted/30">
                      <Map className="h-5 w-5 text-muted-foreground" />
                      <p className="text-sm text-muted-foreground">Select a service area above to enable map drawing</p>
                    </div>
                  ) : (
                    <ZoneBoundaryMap
                      shapeType={formData.shape_type}
                      existingPolygon={formData.geo_boundary}
                      existingCircle={{ center_lat: formData.center_lat, center_lng: formData.center_lng, radius_meters: formData.radius_meters }}
                      region={getSelectedServiceArea()}
                      color={formData.color}
                      onPolygonChange={handlePolygonChange}
                      onCircleChange={handleCircleChange}
                      onShapeTypeChange={handleShapeTypeChange}
                      height="350px"
                    />
                  )}
                </div>

                <Separator />

                {/* Pricing Rules */}
                <div className="space-y-4">
                  <Label className="text-base font-medium">Pricing Rules</Label>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="grid gap-2">
                      <Label>Pickup Fee (£)</Label>
                      <Input type="number" step="0.01" value={formData.metadata.pickup_fee ?? ""} onChange={(e) => setFormData({ ...formData, metadata: { ...formData.metadata, pickup_fee: e.target.value ? parseFloat(e.target.value) : undefined } })} placeholder="0.00" />
                    </div>
                    <div className="grid gap-2">
                      <Label>Dropoff Fee (£)</Label>
                      <Input type="number" step="0.01" value={formData.metadata.dropoff_fee ?? ""} onChange={(e) => setFormData({ ...formData, metadata: { ...formData.metadata, dropoff_fee: e.target.value ? parseFloat(e.target.value) : undefined } })} placeholder="0.00" />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="grid gap-2">
                      <Label>Airport Fee — Pickup (£)</Label>
                      <Input type="number" step="0.01" value={formData.metadata.airport_fee_pickup ?? ""} onChange={(e) => setFormData({ ...formData, metadata: { ...formData.metadata, airport_fee_pickup: e.target.value ? parseFloat(e.target.value) : undefined } })} placeholder="0.00" />
                      <p className="text-xs text-muted-foreground">Optional airport-specific pickup fee</p>
                    </div>
                    <div className="grid gap-2">
                      <Label>Airport Fee — Dropoff (£)</Label>
                      <Input type="number" step="0.01" value={formData.metadata.airport_fee_dropoff ?? ""} onChange={(e) => setFormData({ ...formData, metadata: { ...formData.metadata, airport_fee_dropoff: e.target.value ? parseFloat(e.target.value) : undefined } })} placeholder="0.00" />
                      <p className="text-xs text-muted-foreground">Optional airport-specific dropoff fee</p>
                    </div>
                  </div>

                  <div className="grid gap-2">
                    <Label>Surcharge %</Label>
                    <Input type="number" step="0.1" value={formData.metadata.surcharge_pct ?? ""} onChange={(e) => setFormData({ ...formData, metadata: { ...formData.metadata, surcharge_pct: e.target.value ? parseFloat(e.target.value) : undefined } })} placeholder="0" />
                    <p className="text-xs text-muted-foreground">Percentage added on top of Base Fare (BF) only</p>
                  </div>

                  <Separator />

                  <div className="grid grid-cols-2 gap-4">
                    <div className="grid gap-2">
                      <Label>Fare Override Mode</Label>
                      <Select value={formData.metadata.fare_override_mode || "NONE"} onValueChange={(value) => setFormData({ ...formData, metadata: { ...formData.metadata, fare_override_mode: value as any, fare_override_value: value === 'NONE' ? undefined : formData.metadata.fare_override_value } })}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="NONE">None (default)</SelectItem>
                          <SelectItem value="FIXED_FARE">Fixed Fare</SelectItem>
                          <SelectItem value="MULTIPLIER">Multiplier</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    {formData.metadata.fare_override_mode && formData.metadata.fare_override_mode !== 'NONE' && (
                      <div className="grid gap-2">
                        <Label>{formData.metadata.fare_override_mode === 'FIXED_FARE' ? 'Fixed Fare Amount (£)' : 'Multiplier Factor'}</Label>
                        <Input type="number" step="0.01" value={formData.metadata.fare_override_value ?? ""} onChange={(e) => setFormData({ ...formData, metadata: { ...formData.metadata, fare_override_value: e.target.value ? parseFloat(e.target.value) : undefined } })} placeholder={formData.metadata.fare_override_mode === 'FIXED_FARE' ? '15.00' : '1.2'} />
                        <p className="text-xs text-muted-foreground">
                          {formData.metadata.fare_override_mode === 'FIXED_FARE' ? 'Sets the base fare to this fixed amount' : 'Multiplies the base fare by this factor (e.g. 1.2 = 20% increase)'}
                        </p>
                      </div>
                    )}
                  </div>

                  <div className="grid gap-2">
                    <Label>Notes</Label>
                    <Textarea value={formData.metadata.notes ?? ""} onChange={(e) => setFormData({ ...formData, metadata: { ...formData.metadata, notes: e.target.value || undefined } })} placeholder="Internal notes about this pricing zone..." rows={2} />
                  </div>
                </div>

                <div className="flex items-center justify-between rounded-lg border p-3">
                  <div>
                    <Label>Active Status</Label>
                    <p className="text-xs text-muted-foreground">Zone will be used for fare calculations</p>
                  </div>
                  <Switch checked={formData.is_active} onCheckedChange={(checked) => setFormData({ ...formData, is_active: checked })} />
                </div>
              </div>

              <DialogFooter>
                <Button type="button" variant="outline" onClick={resetForm}>Cancel</Button>
                <Button type="submit" disabled={createMutation.isPending || updateMutation.isPending}>
                  {(createMutation.isPending || updateMutation.isPending) && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                  {editingZone ? "Update Zone" : "Create Zone"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
          </TabsContent>

          <TabsContent value="routes" className="mt-4">
            <ZoneRoutePricingTab />
          </TabsContent>
        </Tabs>
      </div>
    </AdminLayout>
  );
}
