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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { ZoneBoundaryMap } from "@/components/maps/ZoneBoundaryMap";
import { 
  Plus, Edit, Trash2, Target, Search, 
  Map, Radar, DollarSign, RefreshCw, Loader2, Circle, Hexagon
} from "lucide-react";

// Types
interface CustomZone {
  id: string;
  name: string;
  description: string | null;
  zone_type: 'PRICING' | 'GEOFENCE';
  shape_type: 'polygon' | 'circle';
  region_id: string | null;
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
}

interface ZoneMetadata {
  pickup_fee?: number;
  dropoff_fee?: number;
  surge_multiplier?: number;
  min_fare_override?: number;
  trigger_on_enter?: boolean;
  trigger_on_exit?: boolean;
  staging_zone?: boolean;
  auto_arrive_radius_meters?: number;
}

interface Region {
  id: string;
  name: string;
  geo_boundary: any;
}

const ZONE_TYPE_CONFIG = {
  PRICING: {
    label: 'Pricing Zone',
    icon: DollarSign,
    color: 'bg-green-500/10 text-green-600 border-green-500/30',
    description: 'Apply fees, multipliers, or fare overrides'
  },
  GEOFENCE: {
    label: 'Geofence Zone',
    icon: Radar,
    color: 'bg-blue-500/10 text-blue-600 border-blue-500/30',
    description: 'Trigger events on driver enter/exit'
  }
};

const PRESET_COLORS = [
  '#EF4444', '#F97316', '#F59E0B', '#84CC16', '#22C55E',
  '#14B8A6', '#06B6D4', '#3B82F6', '#6366F1', '#8B5CF6',
  '#A855F7', '#D946EF', '#EC4899', '#F43F5E',
];

export default function CustomZones() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [activeTab, setActiveTab] = useState<'PRICING' | 'GEOFENCE'>('PRICING');
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingZone, setEditingZone] = useState<CustomZone | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [regionFilter, setRegionFilter] = useState<string>("all");

  const [formData, setFormData] = useState({
    name: "",
    description: "",
    zone_type: "PRICING" as 'PRICING' | 'GEOFENCE',
    shape_type: "polygon" as 'polygon' | 'circle',
    region_id: "",
    color: "#3B82F6",
    priority: 0,
    is_active: true,
    geo_boundary: null as any,
    center_lat: null as number | null,
    center_lng: null as number | null,
    radius_meters: 500 as number | null,
    metadata: {} as ZoneMetadata,
  });

  // Fetch zones
  const { data: zones = [], isLoading, refetch } = useQuery({
    queryKey: ['custom-zones-enhanced'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('custom_zones')
        .select('*, region:regions(id, name)')
        .order('priority', { ascending: false });
      if (error) throw error;
      return data as CustomZone[];
    },
  });

  // Fetch regions
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

  // Create mutation
  const createMutation = useMutation({
    mutationFn: async (data: typeof formData) => {
      const { error } = await supabase.from('custom_zones').insert({
        name: data.name,
        description: data.description || null,
        zone_type: data.zone_type,
        shape_type: data.shape_type,
        region_id: data.region_id || null,
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
      queryClient.invalidateQueries({ queryKey: ['custom-zones-enhanced'] });
      toast({ title: "Zone created successfully" });
      resetForm();
    },
    onError: (error: any) => {
      toast({ title: "Failed to create zone", description: error.message, variant: "destructive" });
    },
  });

  // Update mutation
  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: typeof formData }) => {
      const { error } = await supabase.from('custom_zones').update({
        name: data.name,
        description: data.description || null,
        zone_type: data.zone_type,
        shape_type: data.shape_type,
        region_id: data.region_id || null,
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
      queryClient.invalidateQueries({ queryKey: ['custom-zones-enhanced'] });
      toast({ title: "Zone updated successfully" });
      resetForm();
    },
    onError: (error: any) => {
      toast({ title: "Failed to update zone", description: error.message, variant: "destructive" });
    },
  });

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('custom_zones').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['custom-zones-enhanced'] });
      toast({ title: "Zone deleted successfully" });
    },
    onError: (error: any) => {
      toast({ title: "Failed to delete zone", description: error.message, variant: "destructive" });
    },
  });

  // Toggle status mutation
  const toggleStatusMutation = useMutation({
    mutationFn: async ({ id, is_active }: { id: string; is_active: boolean }) => {
      const { error } = await supabase.from('custom_zones').update({ is_active }).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['custom-zones-enhanced'] });
      toast({ title: "Zone status updated" });
    },
  });

  // Callback handlers for ZoneBoundaryMap
  const handlePolygonChange = useCallback((boundary: any) => {
    setFormData(prev => ({
      ...prev,
      geo_boundary: boundary,
      center_lat: null,
      center_lng: null,
      radius_meters: null,
    }));
  }, []);

  const handleCircleChange = useCallback((center_lat: number | null, center_lng: number | null, radius_meters: number | null) => {
    setFormData(prev => ({
      ...prev,
      center_lat,
      center_lng,
      radius_meters,
      geo_boundary: null,
    }));
  }, []);

  const handleShapeTypeChange = useCallback((type: 'polygon' | 'circle') => {
    setFormData(prev => ({
      ...prev,
      shape_type: type,
      geo_boundary: null,
      center_lat: null,
      center_lng: null,
      radius_meters: 500,
    }));
  }, []);

  const getSelectedRegion = useCallback(() => {
    if (!formData.region_id) return null;
    return regions.find(r => r.id === formData.region_id) || null;
  }, [formData.region_id, regions]);

  const resetForm = () => {
    setFormData({
      name: "",
      description: "",
      zone_type: activeTab,
      shape_type: "polygon",
      region_id: "",
      color: "#3B82F6",
      priority: 0,
      is_active: true,
      geo_boundary: null,
      center_lat: null,
      center_lng: null,
      radius_meters: 500,
      metadata: {},
    });
    setEditingZone(null);
    setIsDialogOpen(false);
  };

  const handleEdit = (zone: CustomZone) => {
    setEditingZone(zone);
    setFormData({
      name: zone.name,
      description: zone.description || "",
      zone_type: zone.zone_type,
      shape_type: zone.shape_type,
      region_id: zone.region_id || "",
      color: zone.color || "#3B82F6",
      priority: zone.priority || 0,
      is_active: zone.is_active,
      geo_boundary: zone.geo_boundary,
      center_lat: zone.center_lat,
      center_lng: zone.center_lng,
      radius_meters: zone.radius_meters || 500,
      metadata: zone.metadata || {},
    });
    setIsDialogOpen(true);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    // Validate shape is drawn
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
    setFormData(prev => ({
      ...prev,
      zone_type: activeTab,
      name: "",
      description: "",
      geo_boundary: null,
      center_lat: null,
      center_lng: null,
    }));
    setIsDialogOpen(true);
  };

  const getRegionName = (regionId: string | null) => {
    if (!regionId) return "All Regions";
    const region = regions.find(r => r.id === regionId);
    return region?.name || "Unknown";
  };

  // Filter zones
  const filteredZones = zones.filter(zone => {
    const matchesTab = zone.zone_type === activeTab;
    const matchesSearch = zone.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (zone.description?.toLowerCase().includes(searchQuery.toLowerCase()));
    const matchesStatus = statusFilter === "all" || 
      (statusFilter === "active" && zone.is_active) ||
      (statusFilter === "inactive" && !zone.is_active);
    const matchesRegion = regionFilter === "all" || zone.region_id === regionFilter;
    return matchesTab && matchesSearch && matchesStatus && matchesRegion;
  });

  // Stats
  const stats = {
    totalPricing: zones.filter(z => z.zone_type === 'PRICING').length,
    activePricing: zones.filter(z => z.zone_type === 'PRICING' && z.is_active).length,
    totalGeofence: zones.filter(z => z.zone_type === 'GEOFENCE').length,
    activeGeofence: zones.filter(z => z.zone_type === 'GEOFENCE' && z.is_active).length,
  };


  return (
    <AdminLayout title="Custom Zones & Geofencing">
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Custom Zones & Geofencing</h1>
            <p className="text-muted-foreground">
              Define pricing zones and geofence triggers within your service regions
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              <RefreshCw className="h-4 w-4 mr-2" />
              Refresh
            </Button>
            <Button onClick={openCreateDialog}>
              <Plus className="mr-2 h-4 w-4" />
              Add Zone
            </Button>
          </div>
        </div>

        {/* Stats */}
        <div className="grid gap-4 md:grid-cols-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Pricing Zones</CardTitle>
              <DollarSign className="h-4 w-4 text-green-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.totalPricing}</div>
              <p className="text-xs text-muted-foreground">{stats.activePricing} active</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Geofence Zones</CardTitle>
              <Radar className="h-4 w-4 text-blue-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.totalGeofence}</div>
              <p className="text-xs text-muted-foreground">{stats.activeGeofence} active</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Active Regions</CardTitle>
              <Map className="h-4 w-4 text-purple-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{regions.length}</div>
              <p className="text-xs text-muted-foreground">with zone support</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Total Zones</CardTitle>
              <Target className="h-4 w-4 text-primary" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{zones.length}</div>
              <p className="text-xs text-muted-foreground">across all regions</p>
            </CardContent>
          </Card>
        </div>

        {/* Zone Type Tabs */}
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'PRICING' | 'GEOFENCE')}>
          <TabsList className="grid w-full max-w-md grid-cols-2">
            <TabsTrigger value="PRICING" className="gap-2">
              <DollarSign className="h-4 w-4" />
              Pricing Zones
            </TabsTrigger>
            <TabsTrigger value="GEOFENCE" className="gap-2">
              <Radar className="h-4 w-4" />
              Geofence Zones
            </TabsTrigger>
          </TabsList>

          <TabsContent value="PRICING" className="mt-4">
            <Card>
              <CardHeader>
                <CardTitle>Pricing Zones</CardTitle>
                <CardDescription>
                  Apply pickup fees, dropoff fees, surge multipliers, or fare overrides based on location
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ZoneTable
                  zones={filteredZones}
                  isLoading={isLoading}
                  searchQuery={searchQuery}
                  setSearchQuery={setSearchQuery}
                  statusFilter={statusFilter}
                  setStatusFilter={setStatusFilter}
                  regionFilter={regionFilter}
                  setRegionFilter={setRegionFilter}
                  regions={regions}
                  onEdit={handleEdit}
                  onDelete={(id) => deleteMutation.mutate(id)}
                  onToggleStatus={(id, status) => toggleStatusMutation.mutate({ id, is_active: status })}
                  getRegionName={getRegionName}
                  zoneType="PRICING"
                />
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="GEOFENCE" className="mt-4">
            <Card>
              <CardHeader>
                <CardTitle>Geofence Zones</CardTitle>
                <CardDescription>
                  Trigger alerts when drivers enter or exit zones, manage staging areas, and auto-arrive functionality
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ZoneTable
                  zones={filteredZones}
                  isLoading={isLoading}
                  searchQuery={searchQuery}
                  setSearchQuery={setSearchQuery}
                  statusFilter={statusFilter}
                  setStatusFilter={setStatusFilter}
                  regionFilter={regionFilter}
                  setRegionFilter={setRegionFilter}
                  regions={regions}
                  onEdit={handleEdit}
                  onDelete={(id) => deleteMutation.mutate(id)}
                  onToggleStatus={(id, status) => toggleStatusMutation.mutate({ id, is_active: status })}
                  getRegionName={getRegionName}
                  zoneType="GEOFENCE"
                />
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        {/* Create/Edit Dialog */}
        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <form onSubmit={handleSubmit}>
              <DialogHeader>
                <DialogTitle>
                  {editingZone ? "Edit Zone" : `Create ${ZONE_TYPE_CONFIG[formData.zone_type].label}`}
                </DialogTitle>
                <DialogDescription>
                  {ZONE_TYPE_CONFIG[formData.zone_type].description}
                </DialogDescription>
              </DialogHeader>

              <div className="grid gap-4 py-4">
                {/* Basic Info */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="grid gap-2">
                    <Label htmlFor="name">Zone Name *</Label>
                    <Input
                      id="name"
                      value={formData.name}
                      onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                      placeholder="e.g., Airport Terminal 1"
                      required
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label>Region *</Label>
                    <Select
                      value={formData.region_id || "none"}
                      onValueChange={(value) => setFormData({ ...formData, region_id: value === "none" ? "" : value })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select Region" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">Select a region</SelectItem>
                        {regions.map((region) => (
                          <SelectItem key={region.id} value={region.id}>
                            {region.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="description">Description</Label>
                  <Textarea
                    id="description"
                    value={formData.description}
                    onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                    placeholder="Describe this zone..."
                    rows={2}
                  />
                </div>

                <div className="grid grid-cols-3 gap-4">
                  <div className="grid gap-2">
                    <Label>Zone Type</Label>
                    <Select
                      value={formData.zone_type}
                      onValueChange={(value) => setFormData({ ...formData, zone_type: value as 'PRICING' | 'GEOFENCE', metadata: {} })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="PRICING">Pricing Zone</SelectItem>
                        <SelectItem value="GEOFENCE">Geofence Zone</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-2">
                    <Label>Priority</Label>
                    <Input
                      type="number"
                      value={formData.priority}
                      onChange={(e) => setFormData({ ...formData, priority: parseInt(e.target.value) || 0 })}
                      min={0}
                      max={100}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label>Color</Label>
                    <div className="flex flex-wrap gap-1">
                      {PRESET_COLORS.slice(0, 7).map((color) => (
                        <button
                          key={color}
                          type="button"
                          className={`h-6 w-6 rounded-full border-2 transition-transform ${formData.color === color ? 'border-foreground scale-110' : 'border-transparent'}`}
                          style={{ backgroundColor: color }}
                          onClick={() => setFormData({ ...formData, color })}
                        />
                      ))}
                    </div>
                  </div>
                </div>

                <Separator />

                {/* Map Drawing Section */}
                <div className="space-y-3">
                  <Label className="text-base font-medium">Zone Boundary *</Label>
                  {!formData.region_id ? (
                    <div className="flex items-center gap-2 p-4 rounded-lg border border-dashed border-muted-foreground/30 bg-muted/30">
                      <Map className="h-5 w-5 text-muted-foreground" />
                      <p className="text-sm text-muted-foreground">Select a region above to enable map drawing</p>
                    </div>
                  ) : (
                    <ZoneBoundaryMap
                      shapeType={formData.shape_type}
                      existingPolygon={formData.geo_boundary}
                      existingCircle={{
                        center_lat: formData.center_lat,
                        center_lng: formData.center_lng,
                        radius_meters: formData.radius_meters
                      }}
                      region={getSelectedRegion()}
                      color={formData.color}
                      onPolygonChange={handlePolygonChange}
                      onCircleChange={handleCircleChange}
                      onShapeTypeChange={handleShapeTypeChange}
                      height="350px"
                    />
                  )}
                </div>

                <Separator />

                {/* Zone-specific Configuration */}
                {formData.zone_type === 'PRICING' ? (
                  <div className="space-y-4">
                    <Label className="text-base font-medium">Pricing Rules</Label>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="grid gap-2">
                        <Label htmlFor="pickup_fee">Pickup Fee (£)</Label>
                        <Input
                          id="pickup_fee"
                          type="number"
                          step="0.01"
                          value={formData.metadata.pickup_fee || ""}
                          onChange={(e) => setFormData({
                            ...formData,
                            metadata: { ...formData.metadata, pickup_fee: parseFloat(e.target.value) || undefined }
                          })}
                          placeholder="0.00"
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label htmlFor="dropoff_fee">Dropoff Fee (£)</Label>
                        <Input
                          id="dropoff_fee"
                          type="number"
                          step="0.01"
                          value={formData.metadata.dropoff_fee || ""}
                          onChange={(e) => setFormData({
                            ...formData,
                            metadata: { ...formData.metadata, dropoff_fee: parseFloat(e.target.value) || undefined }
                          })}
                          placeholder="0.00"
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label htmlFor="surge_multiplier">Surge Multiplier</Label>
                        <Input
                          id="surge_multiplier"
                          type="number"
                          step="0.1"
                          value={formData.metadata.surge_multiplier || ""}
                          onChange={(e) => setFormData({
                            ...formData,
                            metadata: { ...formData.metadata, surge_multiplier: parseFloat(e.target.value) || undefined }
                          })}
                          placeholder="1.0"
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label htmlFor="min_fare_override">Min Fare Override (£)</Label>
                        <Input
                          id="min_fare_override"
                          type="number"
                          step="0.01"
                          value={formData.metadata.min_fare_override || ""}
                          onChange={(e) => setFormData({
                            ...formData,
                            metadata: { ...formData.metadata, min_fare_override: parseFloat(e.target.value) || undefined }
                          })}
                          placeholder="0.00"
                        />
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <Label className="text-base font-medium">Geofence Triggers</Label>
                    <div className="space-y-3">
                      <div className="flex items-center justify-between rounded-lg border p-3">
                        <div>
                          <Label>Trigger on Enter</Label>
                          <p className="text-xs text-muted-foreground">Fire event when driver enters this zone</p>
                        </div>
                        <Switch
                          checked={formData.metadata.trigger_on_enter || false}
                          onCheckedChange={(checked) => setFormData({
                            ...formData,
                            metadata: { ...formData.metadata, trigger_on_enter: checked }
                          })}
                        />
                      </div>
                      <div className="flex items-center justify-between rounded-lg border p-3">
                        <div>
                          <Label>Trigger on Exit</Label>
                          <p className="text-xs text-muted-foreground">Fire event when driver exits this zone</p>
                        </div>
                        <Switch
                          checked={formData.metadata.trigger_on_exit || false}
                          onCheckedChange={(checked) => setFormData({
                            ...formData,
                            metadata: { ...formData.metadata, trigger_on_exit: checked }
                          })}
                        />
                      </div>
                      <div className="flex items-center justify-between rounded-lg border p-3">
                        <div>
                          <Label>Staging Zone</Label>
                          <p className="text-xs text-muted-foreground">Mark this as a driver staging/waiting area</p>
                        </div>
                        <Switch
                          checked={formData.metadata.staging_zone || false}
                          onCheckedChange={(checked) => setFormData({
                            ...formData,
                            metadata: { ...formData.metadata, staging_zone: checked }
                          })}
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label htmlFor="auto_arrive">Auto-Arrive Radius (meters)</Label>
                        <Input
                          id="auto_arrive"
                          type="number"
                          value={formData.metadata.auto_arrive_radius_meters || ""}
                          onChange={(e) => setFormData({
                            ...formData,
                            metadata: { ...formData.metadata, auto_arrive_radius_meters: parseInt(e.target.value) || undefined }
                          })}
                          placeholder="Optional - leave empty to disable"
                        />
                        <p className="text-xs text-muted-foreground">
                          Automatically mark driver as arrived when within this radius of pickup
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                <div className="flex items-center justify-between rounded-lg border p-3">
                  <div>
                    <Label>Active Status</Label>
                    <p className="text-xs text-muted-foreground">Zone will be used for {formData.zone_type === 'PRICING' ? 'fare calculations' : 'geofence triggers'}</p>
                  </div>
                  <Switch
                    checked={formData.is_active}
                    onCheckedChange={(checked) => setFormData({ ...formData, is_active: checked })}
                  />
                </div>
              </div>

              <DialogFooter>
                <Button type="button" variant="outline" onClick={resetForm}>
                  Cancel
                </Button>
                <Button type="submit" disabled={createMutation.isPending || updateMutation.isPending}>
                  {createMutation.isPending || updateMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  ) : null}
                  {editingZone ? "Update Zone" : "Create Zone"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

      </div>
    </AdminLayout>
  );
}

// Zone Table Component
interface ZoneTableProps {
  zones: CustomZone[];
  isLoading: boolean;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  statusFilter: string;
  setStatusFilter: (s: string) => void;
  regionFilter: string;
  setRegionFilter: (r: string) => void;
  regions: Region[];
  onEdit: (zone: CustomZone) => void;
  onDelete: (id: string) => void;
  onToggleStatus: (id: string, status: boolean) => void;
  getRegionName: (id: string | null) => string;
  zoneType: 'PRICING' | 'GEOFENCE';
}

function ZoneTable({
  zones,
  isLoading,
  searchQuery,
  setSearchQuery,
  statusFilter,
  setStatusFilter,
  regionFilter,
  setRegionFilter,
  regions,
  onEdit,
  onDelete,
  onToggleStatus,
  getRegionName,
  zoneType,
}: ZoneTableProps) {
  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-col gap-4 md:flex-row md:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search zones..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10"
          />
        </div>
        <Select value={regionFilter} onValueChange={setRegionFilter}>
          <SelectTrigger className="w-[180px]">
            <Map className="mr-2 h-4 w-4" />
            <SelectValue placeholder="Region" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Regions</SelectItem>
            {regions.map((region) => (
              <SelectItem key={region.id} value={region.id}>{region.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[150px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
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
      ) : zones.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground">
          <Target className="h-12 w-12 mx-auto mb-4 opacity-50" />
          <p>No {zoneType.toLowerCase()} zones found</p>
          <p className="text-sm mt-1">Create a zone to get started</p>
        </div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Zone</TableHead>
                <TableHead>Region</TableHead>
                <TableHead>Shape</TableHead>
                <TableHead>Priority</TableHead>
                <TableHead>{zoneType === 'PRICING' ? 'Rules' : 'Triggers'}</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {zones.map((zone) => (
                <TableRow key={zone.id}>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <div
                        className="h-4 w-4 rounded-full"
                        style={{ backgroundColor: zone.color || '#3B82F6' }}
                      />
                      <div>
                        <p className="font-medium">{zone.name}</p>
                        {zone.description && (
                          <p className="text-xs text-muted-foreground truncate max-w-[200px]">
                            {zone.description}
                          </p>
                        )}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>{getRegionName(zone.region_id)}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="gap-1">
                      {zone.shape_type === 'polygon' ? (
                        <Hexagon className="h-3 w-3" />
                      ) : (
                        <Circle className="h-3 w-3" />
                      )}
                      {zone.shape_type}
                    </Badge>
                  </TableCell>
                  <TableCell>{zone.priority || 0}</TableCell>
                  <TableCell>
                    {zoneType === 'PRICING' ? (
                      <div className="space-y-1 text-xs">
                        {zone.metadata?.pickup_fee && <div>Pickup: £{zone.metadata.pickup_fee}</div>}
                        {zone.metadata?.dropoff_fee && <div>Dropoff: £{zone.metadata.dropoff_fee}</div>}
                        {zone.metadata?.surge_multiplier && <div>Surge: {zone.metadata.surge_multiplier}x</div>}
                        {!zone.metadata?.pickup_fee && !zone.metadata?.dropoff_fee && !zone.metadata?.surge_multiplier && (
                          <span className="text-muted-foreground">No rules</span>
                        )}
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {zone.metadata?.trigger_on_enter && (
                          <Badge variant="secondary" className="text-xs">Enter</Badge>
                        )}
                        {zone.metadata?.trigger_on_exit && (
                          <Badge variant="secondary" className="text-xs">Exit</Badge>
                        )}
                        {zone.metadata?.staging_zone && (
                          <Badge variant="secondary" className="text-xs">Staging</Badge>
                        )}
                        {zone.metadata?.auto_arrive_radius_meters && (
                          <Badge variant="secondary" className="text-xs">Auto-arrive</Badge>
                        )}
                        {!zone.metadata?.trigger_on_enter && !zone.metadata?.trigger_on_exit && 
                         !zone.metadata?.staging_zone && !zone.metadata?.auto_arrive_radius_meters && (
                          <span className="text-xs text-muted-foreground">No triggers</span>
                        )}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={zone.is_active}
                      onCheckedChange={(checked) => onToggleStatus(zone.id, checked)}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-2">
                      <Button variant="ghost" size="icon" onClick={() => onEdit(zone)}>
                        <Edit className="h-4 w-4" />
                      </Button>
                      <Button 
                        variant="ghost" 
                        size="icon" 
                        className="text-destructive hover:text-destructive"
                        onClick={() => onDelete(zone.id)}
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
      )}
    </div>
  );
}
