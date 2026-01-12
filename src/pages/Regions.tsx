import { useEffect, useState } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
import { supabase } from '@/integrations/supabase/client';
import { Plus, MapPin, Loader2, MoreHorizontal, Pencil, Trash2, Globe, Users, Map } from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';

interface Region {
  id: string;
  name: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface RegionStats {
  drivers: number;
  serviceAreas: number;
}

export default function Regions() {
  const [regions, setRegions] = useState<Region[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Dialog states
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [selectedRegion, setSelectedRegion] = useState<Region | null>(null);

  // Form states
  const [formData, setFormData] = useState({ name: '', status: 'active' });
  const [isSaving, setIsSaving] = useState(false);

  // Stats
  const [regionStats, setRegionStats] = useState<Record<string, RegionStats>>({});

  const fetchRegions = async () => {
    try {
      setIsLoading(true);
      const { data, error } = await supabase
        .from('regions')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) throw error;
      setRegions(data || []);

      // Fetch stats for each region
      if (data && data.length > 0) {
        const stats: Record<string, RegionStats> = {};
        
        for (const region of data) {
          const [driversRes, areasRes] = await Promise.all([
            supabase.from('drivers').select('id', { count: 'exact', head: true }).eq('region_id', region.id),
            supabase.from('service_areas').select('id', { count: 'exact', head: true }).eq('region_id', region.id),
          ]);
          
          stats[region.id] = {
            drivers: driversRes.count || 0,
            serviceAreas: areasRes.count || 0,
          };
        }
        
        setRegionStats(stats);
      }
    } catch (err) {
      console.error('Error fetching regions:', err);
      setError('Failed to load regions. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchRegions();
  }, []);

  const handleAdd = async () => {
    if (!formData.name.trim()) {
      toast.error('Please enter a region name');
      return;
    }

    setIsSaving(true);
    try {
      const { data, error } = await supabase
        .from('regions')
        .insert({ name: formData.name, status: formData.status })
        .select()
        .single();

      if (error) throw error;

      setRegions(prev => [data, ...prev]);
      setRegionStats(prev => ({ ...prev, [data.id]: { drivers: 0, serviceAreas: 0 } }));
      toast.success('Region created successfully');
      setIsAddDialogOpen(false);
      setFormData({ name: '', status: 'active' });
    } catch (err: any) {
      console.error('Error creating region:', err);
      toast.error(err.message || 'Failed to create region');
    } finally {
      setIsSaving(false);
    }
  };

  const handleEdit = async () => {
    if (!selectedRegion || !formData.name.trim()) {
      toast.error('Please enter a region name');
      return;
    }

    setIsSaving(true);
    try {
      const { error } = await supabase
        .from('regions')
        .update({ name: formData.name, status: formData.status })
        .eq('id', selectedRegion.id);

      if (error) throw error;

      setRegions(prev =>
        prev.map(r => r.id === selectedRegion.id ? { ...r, name: formData.name, status: formData.status } : r)
      );
      toast.success('Region updated successfully');
      setIsEditDialogOpen(false);
      setSelectedRegion(null);
    } catch (err: any) {
      console.error('Error updating region:', err);
      toast.error(err.message || 'Failed to update region');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedRegion) return;

    setIsSaving(true);
    try {
      const { error } = await supabase
        .from('regions')
        .delete()
        .eq('id', selectedRegion.id);

      if (error) throw error;

      setRegions(prev => prev.filter(r => r.id !== selectedRegion.id));
      toast.success('Region deleted successfully');
      setIsDeleteDialogOpen(false);
      setSelectedRegion(null);
    } catch (err: any) {
      console.error('Error deleting region:', err);
      toast.error(err.message || 'Failed to delete region. Make sure no drivers or service areas are assigned.');
    } finally {
      setIsSaving(false);
    }
  };

  const openEditDialog = (region: Region) => {
    setSelectedRegion(region);
    setFormData({ name: region.name, status: region.status });
    setIsEditDialogOpen(true);
  };

  const openDeleteDialog = (region: Region) => {
    setSelectedRegion(region);
    setIsDeleteDialogOpen(true);
  };

  const totalDrivers = Object.values(regionStats).reduce((sum, s) => sum + s.drivers, 0);
  const totalServiceAreas = Object.values(regionStats).reduce((sum, s) => sum + s.serviceAreas, 0);

  return (
    <AdminLayout 
      title="Regions" 
      description="Manage operational regions for your service"
    >
      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Total Regions</p>
                <p className="text-2xl font-bold">{regions.length}</p>
              </div>
              <Globe className="h-8 w-8 text-primary opacity-80" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Total Drivers</p>
                <p className="text-2xl font-bold">{totalDrivers}</p>
              </div>
              <Users className="h-8 w-8 text-blue-500 opacity-80" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Service Areas</p>
                <p className="text-2xl font-bold">{totalServiceAreas}</p>
              </div>
              <Map className="h-8 w-8 text-green-500 opacity-80" />
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <MapPin className="h-5 w-5 text-primary" />
            All Regions
          </CardTitle>
          <Button onClick={() => {
            setFormData({ name: '', status: 'active' });
            setIsAddDialogOpen(true);
          }}>
            <Plus className="mr-2 h-4 w-4" />
            Add Region
          </Button>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
          ) : error ? (
            <div className="py-8 text-center text-destructive">{error}</div>
          ) : regions.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground">
              No regions found. Create your first region to get started.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Drivers</TableHead>
                  <TableHead>Service Areas</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {regions.map((region) => (
                  <TableRow key={region.id}>
                    <TableCell className="font-medium">{region.name}</TableCell>
                    <TableCell>
                      <Badge
                        variant={region.status === 'active' ? 'default' : 'secondary'}
                        className={
                          region.status === 'active'
                            ? 'bg-green-500/10 text-green-600 hover:bg-green-500/20'
                            : 'bg-gray-500/10 text-gray-600'
                        }
                      >
                        {region.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm">{regionStats[region.id]?.drivers || 0}</span>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm">{regionStats[region.id]?.serviceAreas || 0}</span>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {format(new Date(region.created_at), 'MMM d, yyyy')}
                    </TableCell>
                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => openEditDialog(region)}>
                            <Pencil className="mr-2 h-4 w-4" />
                            Edit
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem 
                            onClick={() => openDeleteDialog(region)}
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

      {/* Add Region Dialog */}
      <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MapPin className="h-5 w-5" />
              Add New Region
            </DialogTitle>
            <DialogDescription>
              Create a new operational region for your service
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="name">Region Name</Label>
              <Input
                id="name"
                placeholder="e.g., London, Manchester, Birmingham"
                value={formData.name}
                onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
              />
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="status">Status</Label>
              <Select
                value={formData.status}
                onValueChange={(value) => setFormData(prev => ({ ...prev, status: value }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="inactive">Inactive</SelectItem>
                </SelectContent>
              </Select>
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
                  Create Region
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Region Dialog */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="h-5 w-5" />
              Edit Region
            </DialogTitle>
            <DialogDescription>
              Update region information
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="edit_name">Region Name</Label>
              <Input
                id="edit_name"
                value={formData.name}
                onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
              />
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="edit_status">Status</Label>
              <Select
                value={formData.status}
                onValueChange={(value) => setFormData(prev => ({ ...prev, status: value }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="inactive">Inactive</SelectItem>
                </SelectContent>
              </Select>
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
            <AlertDialogTitle>Delete Region</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{selectedRegion?.name}"? This action cannot be undone.
              Make sure no drivers or service areas are assigned to this region.
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
