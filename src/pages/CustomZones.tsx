import { useState } from "react";
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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { Plus, Edit, Trash2, MapPin, Target, CircleDollarSign, Search, Filter, TrendingUp, TrendingDown, AlertTriangle, Navigation } from "lucide-react";
import { format } from "date-fns";

interface CustomZone {
  id: string;
  name: string;
  description: string | null;
  zone_type: string;
  region_id: string | null;
  geo_boundary: any;
  is_active: boolean;
  color: string | null;
  priority: number | null;
  created_at: string;
  updated_at: string;
}

interface Region {
  id: string;
  name: string;
}

const ZONE_TYPES = [
  { value: 'surge', label: 'Surge Zone', icon: TrendingUp, color: 'bg-red-500' },
  { value: 'discount', label: 'Discount Zone', icon: TrendingDown, color: 'bg-green-500' },
  { value: 'pickup', label: 'Pickup Only', icon: Navigation, color: 'bg-blue-500' },
  { value: 'dropoff', label: 'Dropoff Only', icon: MapPin, color: 'bg-purple-500' },
  { value: 'restricted', label: 'Restricted', icon: AlertTriangle, color: 'bg-orange-500' },
];

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
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const [formData, setFormData] = useState({
    name: "",
    description: "",
    zone_type: "surge",
    region_id: "",
    color: "#3B82F6",
    priority: 0,
    is_active: true,
  });

  const { data: zones = [], isLoading } = useQuery({
    queryKey: ['custom-zones'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('custom_zones')
        .select('*')
        .order('priority', { ascending: false });
      if (error) throw error;
      return data as CustomZone[];
    },
  });

  const { data: regions = [] } = useQuery({
    queryKey: ['regions'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('regions')
        .select('id, name')
        .order('name');
      if (error) throw error;
      return data as Region[];
    },
  });

  const createMutation = useMutation({
    mutationFn: async (data: typeof formData) => {
      const { error } = await supabase.from('custom_zones').insert({
        name: data.name,
        description: data.description || null,
        zone_type: data.zone_type,
        region_id: data.region_id || null,
        color: data.color,
        priority: data.priority,
        is_active: data.is_active,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['custom-zones'] });
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
        zone_type: data.zone_type,
        region_id: data.region_id || null,
        color: data.color,
        priority: data.priority,
        is_active: data.is_active,
      }).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['custom-zones'] });
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
      queryClient.invalidateQueries({ queryKey: ['custom-zones'] });
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
      queryClient.invalidateQueries({ queryKey: ['custom-zones'] });
      toast({ title: "Zone status updated" });
    },
  });

  const resetForm = () => {
    setFormData({
      name: "",
      description: "",
      zone_type: "surge",
      region_id: "",
      color: "#3B82F6",
      priority: 0,
      is_active: true,
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
      region_id: zone.region_id || "",
      color: zone.color || "#3B82F6",
      priority: zone.priority || 0,
      is_active: zone.is_active,
    });
    setIsDialogOpen(true);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (editingZone) {
      updateMutation.mutate({ id: editingZone.id, data: formData });
    } else {
      createMutation.mutate(formData);
    }
  };

  const getZoneTypeInfo = (type: string) => {
    return ZONE_TYPES.find(t => t.value === type) || ZONE_TYPES[0];
  };

  const getRegionName = (regionId: string | null) => {
    if (!regionId) return "All Regions";
    const region = regions.find(r => r.id === regionId);
    return region?.name || "Unknown";
  };

  const filteredZones = zones.filter(zone => {
    const matchesSearch = zone.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (zone.description?.toLowerCase().includes(searchQuery.toLowerCase()));
    const matchesType = typeFilter === "all" || zone.zone_type === typeFilter;
    const matchesStatus = statusFilter === "all" || 
      (statusFilter === "active" && zone.is_active) ||
      (statusFilter === "inactive" && !zone.is_active);
    return matchesSearch && matchesType && matchesStatus;
  });

  const stats = {
    total: zones.length,
    active: zones.filter(z => z.is_active).length,
    surge: zones.filter(z => z.zone_type === 'surge').length,
    discount: zones.filter(z => z.zone_type === 'discount').length,
  };

  return (
    <AdminLayout title="Custom Zones">
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Custom Zones</h1>
            <p className="text-muted-foreground">Define geographic zones with special pricing rules</p>
          </div>
          <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
            <DialogTrigger asChild>
              <Button onClick={() => resetForm()}>
                <Plus className="mr-2 h-4 w-4" />
                Add Zone
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-lg">
              <form onSubmit={handleSubmit}>
                <DialogHeader>
                  <DialogTitle>{editingZone ? "Edit Zone" : "Create Zone"}</DialogTitle>
                  <DialogDescription>
                    Define a custom zone with specific pricing or restrictions
                  </DialogDescription>
                </DialogHeader>
                <div className="grid gap-4 py-4">
                  <div className="grid gap-2">
                    <Label htmlFor="name">Zone Name *</Label>
                    <Input
                      id="name"
                      value={formData.name}
                      onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                      placeholder="e.g., Downtown Surge Area"
                      required
                    />
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

                  <div className="grid grid-cols-2 gap-4">
                    <div className="grid gap-2">
                      <Label>Zone Type *</Label>
                      <Select
                        value={formData.zone_type}
                        onValueChange={(value) => setFormData({ ...formData, zone_type: value })}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ZONE_TYPES.map((type) => (
                            <SelectItem key={type.value} value={type.value}>
                              <div className="flex items-center gap-2">
                                <type.icon className="h-4 w-4" />
                                {type.label}
                              </div>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="grid gap-2">
                      <Label>Region</Label>
                      <Select
                        value={formData.region_id || "all"}
                        onValueChange={(value) => setFormData({ ...formData, region_id: value === "all" ? "" : value })}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="All Regions" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All Regions</SelectItem>
                          {regions.map((region) => (
                            <SelectItem key={region.id} value={region.id}>
                              {region.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="grid gap-2">
                      <Label>Priority</Label>
                      <Input
                        type="number"
                        value={formData.priority}
                        onChange={(e) => setFormData({ ...formData, priority: parseInt(e.target.value) || 0 })}
                        min={0}
                        max={100}
                      />
                      <p className="text-xs text-muted-foreground">Higher priority zones override lower ones</p>
                    </div>

                    <div className="grid gap-2">
                      <Label>Zone Color</Label>
                      <div className="flex flex-wrap gap-2">
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

                  <div className="flex items-center justify-between rounded-lg border p-3">
                    <div>
                      <Label>Active Status</Label>
                      <p className="text-xs text-muted-foreground">Zone will be applied to fare calculations</p>
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
                    {editingZone ? "Update Zone" : "Create Zone"}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        </div>

        {/* Stats */}
        <div className="grid gap-4 md:grid-cols-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Total Zones</CardTitle>
              <Target className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.total}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Active Zones</CardTitle>
              <CircleDollarSign className="h-4 w-4 text-green-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-500">{stats.active}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Surge Zones</CardTitle>
              <TrendingUp className="h-4 w-4 text-red-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-red-500">{stats.surge}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Discount Zones</CardTitle>
              <TrendingDown className="h-4 w-4 text-blue-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-blue-500">{stats.discount}</div>
            </CardContent>
          </Card>
        </div>

        {/* Filters */}
        <Card>
          <CardContent className="pt-6">
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
              <Select value={typeFilter} onValueChange={setTypeFilter}>
                <SelectTrigger className="w-[180px]">
                  <Filter className="mr-2 h-4 w-4" />
                  <SelectValue placeholder="Zone Type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  {ZONE_TYPES.map((type) => (
                    <SelectItem key={type.value} value={type.value}>{type.label}</SelectItem>
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
          </CardContent>
        </Card>

        {/* Zones Table */}
        <Card>
          <CardHeader>
            <CardTitle>Zones</CardTitle>
            <CardDescription>
              {filteredZones.length} zone{filteredZones.length !== 1 ? 's' : ''} found
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
              </div>
            ) : filteredZones.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                No zones found. Create your first zone to get started.
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Zone</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Region</TableHead>
                    <TableHead>Priority</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredZones.map((zone) => {
                    const typeInfo = getZoneTypeInfo(zone.zone_type);
                    return (
                      <TableRow key={zone.id}>
                        <TableCell>
                          <div className="flex items-center gap-3">
                            <div
                              className="h-4 w-4 rounded-full shrink-0"
                              style={{ backgroundColor: zone.color || '#3B82F6' }}
                            />
                            <div>
                              <div className="font-medium">{zone.name}</div>
                              {zone.description && (
                                <div className="text-xs text-muted-foreground line-clamp-1">
                                  {zone.description}
                                </div>
                              )}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="gap-1">
                            <typeInfo.icon className="h-3 w-3" />
                            {typeInfo.label}
                          </Badge>
                        </TableCell>
                        <TableCell>{getRegionName(zone.region_id)}</TableCell>
                        <TableCell>
                          <Badge variant="secondary">{zone.priority}</Badge>
                        </TableCell>
                        <TableCell>
                          <Switch
                            checked={zone.is_active}
                            onCheckedChange={(checked) => 
                              toggleStatusMutation.mutate({ id: zone.id, is_active: checked })
                            }
                          />
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {format(new Date(zone.created_at), 'MMM d, yyyy')}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => handleEdit(zone)}
                            >
                              <Edit className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="text-destructive hover:text-destructive"
                              onClick={() => {
                                if (confirm('Are you sure you want to delete this zone?')) {
                                  deleteMutation.mutate(zone.id);
                                }
                              }}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </AdminLayout>
  );
}
