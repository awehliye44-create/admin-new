import { useEffect, useState } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { supabase } from '@/integrations/supabase/client';
import { Plus, Navigation, Loader2, MoreHorizontal, Pencil, Trash2, MapPin, Search, Users } from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';

interface ServiceArea {
  id: string;
  name: string;
  region_id: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  region?: {
    name: string;
  };
}

interface Region {
  id: string;
  name: string;
}

export default function Services() {
  const [serviceAreas, setServiceAreas] = useState<ServiceArea[]>([]);
  const [regions, setRegions] = useState<Region[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [regionFilter, setRegionFilter] = useState<string>('all');

  // Dialog states
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [selectedArea, setSelectedArea] = useState<ServiceArea | null>(null);

  // Form states
  const [formData, setFormData] = useState({ name: '', region_id: '', is_active: true });
  const [isSaving, setIsSaving] = useState(false);

  // Driver counts per service area
  const [driverCounts, setDriverCounts] = useState<Record<string, number>>({});

  const fetchData = async () => {
    try {
      setIsLoading(true);
      
      const [areasRes, regionsRes] = await Promise.all([
        supabase
          .from('service_areas')
          .select(`*, region:regions(name)`)
          .order('name', { ascending: true }),
        supabase
          .from('regions')
          .select('id, name')
          .order('name', { ascending: true }),
      ]);

      if (areasRes.error) throw areasRes.error;
      if (regionsRes.error) throw regionsRes.error;

      setServiceAreas(areasRes.data || []);
      setRegions(regionsRes.data || []);

      // Fetch driver counts per service area
      if (areasRes.data && areasRes.data.length > 0) {
        const { data: driverServiceAreas } = await supabase
          .from('driver_service_areas')
          .select('service_area_id');

        if (driverServiceAreas) {
          const counts: Record<string, number> = {};
          driverServiceAreas.forEach(dsa => {
            counts[dsa.service_area_id] = (counts[dsa.service_area_id] || 0) + 1;
          });
          setDriverCounts(counts);
        }
      }
    } catch (err) {
      console.error('Error fetching data:', err);
      setError('Failed to load service areas. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleAdd = async () => {
    if (!formData.name.trim()) {
      toast.error('Please enter a service area name');
      return;
    }
    if (!formData.region_id) {
      toast.error('Please select a region');
      return;
    }

    setIsSaving(true);
    try {
      const { data, error } = await supabase
        .from('service_areas')
        .insert({ 
          name: formData.name, 
          region_id: formData.region_id, 
          is_active: formData.is_active 
        })
        .select(`*, region:regions(name)`)
        .single();

      if (error) throw error;

      setServiceAreas(prev => [...prev, data].sort((a, b) => a.name.localeCompare(b.name)));
      toast.success('Service area created successfully');
      setIsAddDialogOpen(false);
      setFormData({ name: '', region_id: '', is_active: true });
    } catch (err: any) {
      console.error('Error creating service area:', err);
      toast.error(err.message || 'Failed to create service area');
    } finally {
      setIsSaving(false);
    }
  };

  const handleEdit = async () => {
    if (!selectedArea || !formData.name.trim()) {
      toast.error('Please enter a service area name');
      return;
    }

    setIsSaving(true);
    try {
      const { data, error } = await supabase
        .from('service_areas')
        .update({ 
          name: formData.name, 
          region_id: formData.region_id, 
          is_active: formData.is_active 
        })
        .eq('id', selectedArea.id)
        .select(`*, region:regions(name)`)
        .single();

      if (error) throw error;

      setServiceAreas(prev =>
        prev.map(a => a.id === selectedArea.id ? data : a).sort((a, b) => a.name.localeCompare(b.name))
      );
      toast.success('Service area updated successfully');
      setIsEditDialogOpen(false);
      setSelectedArea(null);
    } catch (err: any) {
      console.error('Error updating service area:', err);
      toast.error(err.message || 'Failed to update service area');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedArea) return;

    setIsSaving(true);
    try {
      const { error } = await supabase
        .from('service_areas')
        .delete()
        .eq('id', selectedArea.id);

      if (error) throw error;

      setServiceAreas(prev => prev.filter(a => a.id !== selectedArea.id));
      toast.success('Service area deleted successfully');
      setIsDeleteDialogOpen(false);
      setSelectedArea(null);
    } catch (err: any) {
      console.error('Error deleting service area:', err);
      toast.error(err.message || 'Failed to delete service area');
    } finally {
      setIsSaving(false);
    }
  };

  const toggleStatus = async (area: ServiceArea) => {
    try {
      const { error } = await supabase
        .from('service_areas')
        .update({ is_active: !area.is_active })
        .eq('id', area.id);

      if (error) throw error;

      setServiceAreas(prev =>
        prev.map(a => a.id === area.id ? { ...a, is_active: !a.is_active } : a)
      );
      toast.success(`Service area ${!area.is_active ? 'activated' : 'deactivated'}`);
    } catch (err: any) {
      console.error('Error toggling status:', err);
      toast.error('Failed to update status');
    }
  };

  const openEditDialog = (area: ServiceArea) => {
    setSelectedArea(area);
    setFormData({ name: area.name, region_id: area.region_id, is_active: area.is_active });
    setIsEditDialogOpen(true);
  };

  const openDeleteDialog = (area: ServiceArea) => {
    setSelectedArea(area);
    setIsDeleteDialogOpen(true);
  };

  const filteredAreas = serviceAreas.filter(area => {
    const matchesSearch = area.name.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesRegion = regionFilter === 'all' || area.region_id === regionFilter;
    return matchesSearch && matchesRegion;
  });

  const activeCount = serviceAreas.filter(a => a.is_active).length;
  const inactiveCount = serviceAreas.filter(a => !a.is_active).length;

  return (
    <AdminLayout 
      title="Service Areas" 
      description="Manage service zones within your regions"
    >
      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Total Areas</p>
                <p className="text-2xl font-bold">{serviceAreas.length}</p>
              </div>
              <Navigation className="h-8 w-8 text-primary opacity-80" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-green-500/30 bg-green-500/5">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Active</p>
                <p className="text-2xl font-bold text-green-600">{activeCount}</p>
              </div>
              <MapPin className="h-8 w-8 text-green-500" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-gray-500/30 bg-gray-500/5">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Inactive</p>
                <p className="text-2xl font-bold text-gray-600">{inactiveCount}</p>
              </div>
              <MapPin className="h-8 w-8 text-gray-400" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Regions</p>
                <p className="text-2xl font-bold">{regions.length}</p>
              </div>
              <MapPin className="h-8 w-8 text-blue-500 opacity-80" />
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <CardTitle className="flex items-center gap-2">
            <Navigation className="h-5 w-5 text-primary" />
            All Service Areas
          </CardTitle>
          <div className="flex flex-col gap-2 md:flex-row md:items-center">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search areas..."
                className="pl-9 w-full md:w-[200px]"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
            <Select value={regionFilter} onValueChange={setRegionFilter}>
              <SelectTrigger className="w-full md:w-[180px]">
                <SelectValue placeholder="Filter by region" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Regions</SelectItem>
                {regions.map(region => (
                  <SelectItem key={region.id} value={region.id}>{region.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button onClick={() => {
              setFormData({ name: '', region_id: regions[0]?.id || '', is_active: true });
              setIsAddDialogOpen(true);
            }}>
              <Plus className="mr-2 h-4 w-4" />
              Add Area
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
          ) : error ? (
            <div className="py-8 text-center text-destructive">{error}</div>
          ) : filteredAreas.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground">
              {searchQuery || regionFilter !== 'all' 
                ? 'No service areas found matching your filters.' 
                : 'No service areas found. Create your first service area to get started.'}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Region</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Drivers</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredAreas.map((area) => (
                  <TableRow key={area.id}>
                    <TableCell className="font-medium">{area.name}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{area.region?.name || 'Unknown'}</Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={area.is_active}
                          onCheckedChange={() => toggleStatus(area)}
                        />
                        <Badge
                          variant={area.is_active ? 'default' : 'secondary'}
                          className={
                            area.is_active
                              ? 'bg-green-500/10 text-green-600'
                              : 'bg-gray-500/10 text-gray-600'
                          }
                        >
                          {area.is_active ? 'Active' : 'Inactive'}
                        </Badge>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Users className="h-4 w-4 text-muted-foreground" />
                        <span>{driverCounts[area.id] || 0}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {format(new Date(area.created_at), 'MMM d, yyyy')}
                    </TableCell>
                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => openEditDialog(area)}>
                            <Pencil className="mr-2 h-4 w-4" />
                            Edit
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem 
                            onClick={() => openDeleteDialog(area)}
                            className="text-red-600"
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Add Service Area Dialog */}
      <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Navigation className="h-5 w-5" />
              Add New Service Area
            </DialogTitle>
            <DialogDescription>
              Create a new service area within a region
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="name">Area Name</Label>
              <Input
                id="name"
                placeholder="e.g., Central London, North Manchester"
                value={formData.name}
                onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
              />
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="region">Region</Label>
              <Select
                value={formData.region_id}
                onValueChange={(value) => setFormData(prev => ({ ...prev, region_id: value }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a region" />
                </SelectTrigger>
                <SelectContent>
                  {regions.map(region => (
                    <SelectItem key={region.id} value={region.id}>{region.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center justify-between">
              <Label htmlFor="is_active">Active</Label>
              <Switch
                id="is_active"
                checked={formData.is_active}
                onCheckedChange={(checked) => setFormData(prev => ({ ...prev, is_active: checked }))}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsAddDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleAdd} disabled={isSaving}>
              {isSaving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Creating...
                </>
              ) : (
                <>
                  <Plus className="mr-2 h-4 w-4" />
                  Create Area
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Service Area Dialog */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="h-5 w-5" />
              Edit Service Area
            </DialogTitle>
            <DialogDescription>
              Update service area information
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="edit_name">Area Name</Label>
              <Input
                id="edit_name"
                value={formData.name}
                onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
              />
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="edit_region">Region</Label>
              <Select
                value={formData.region_id}
                onValueChange={(value) => setFormData(prev => ({ ...prev, region_id: value }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {regions.map(region => (
                    <SelectItem key={region.id} value={region.id}>{region.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center justify-between">
              <Label htmlFor="edit_is_active">Active</Label>
              <Switch
                id="edit_is_active"
                checked={formData.is_active}
                onCheckedChange={(checked) => setFormData(prev => ({ ...prev, is_active: checked }))}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsEditDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleEdit} disabled={isSaving}>
              {isSaving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : (
                'Save Changes'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Service Area</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{selectedArea?.name}"? This action cannot be undone.
              Drivers assigned to this area will be unassigned.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-red-600 hover:bg-red-700"
              disabled={isSaving}
            >
              {isSaving ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AdminLayout>
  );
}
