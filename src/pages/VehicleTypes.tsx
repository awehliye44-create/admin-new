import { useEffect, useState } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
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
import { 
  Car, Plus, Search, Loader2, Pencil, Trash2, Users, 
  CheckCircle2, XCircle, Tag, Sparkles, Zap
} from 'lucide-react';
import { toast } from 'sonner';

interface VehicleType {
  id: string;
  name: string;
  description: string | null;
  slug: string;
  icon: string | null;
  is_active: boolean;
  is_default: boolean;
  driver_controllable: boolean;
  display_order: number | null;
  capacity: number;
  categories: string[];
  features: string[];
  created_at: string;
  updated_at: string;
}

// Predefined options
const CATEGORY_OPTIONS = ['Economy', 'Standard', 'XL', 'Luxury', 'Premium'];
const FEATURE_OPTIONS = ['Luxury', 'Pet', 'Wheelchair', 'Child Seat', 'WiFi', 'Charger', 'Electric'];

export default function VehicleTypes() {
  const [vehicleTypes, setVehicleTypes] = useState<VehicleType[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  
  // Dialog states
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [selectedType, setSelectedType] = useState<VehicleType | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // Form state
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    slug: '',
    capacity: 4,
    categories: ['Standard'] as string[],
    features: [] as string[],
    is_active: true,
    is_default: false,
    driver_controllable: false,
    display_order: 0,
  });

  const fetchVehicleTypes = async () => {
    try {
      setIsLoading(true);
      const { data, error } = await supabase
        .from('vehicle_types')
        .select('*')
        .order('display_order', { ascending: true });

      if (error) throw error;
      setVehicleTypes(data || []);
    } catch (err) {
      console.error('Error fetching vehicle types:', err);
      toast.error('Failed to load vehicle types');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchVehicleTypes();
  }, []);

  const generateSlug = (name: string) => {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  };

  const handleNameChange = (name: string) => {
    setFormData(prev => ({
      ...prev,
      name,
      slug: prev.slug || generateSlug(name),
    }));
  };

  const toggleCategory = (category: string) => {
    setFormData(prev => ({
      ...prev,
      categories: prev.categories.includes(category)
        ? prev.categories.filter(c => c !== category)
        : [...prev.categories, category],
    }));
  };

  const toggleFeature = (feature: string) => {
    setFormData(prev => ({
      ...prev,
      features: prev.features.includes(feature)
        ? prev.features.filter(f => f !== feature)
        : [...prev.features, feature],
    }));
  };

  const resetForm = () => {
    setFormData({
      name: '',
      description: '',
      slug: '',
      capacity: 4,
      categories: ['Standard'],
      features: [],
      is_active: true,
      is_default: false,
      driver_controllable: false,
      display_order: vehicleTypes.length,
    });
  };

  const handleAdd = async () => {
    if (!formData.name.trim() || !formData.slug.trim()) {
      toast.error('Name and code are required');
      return;
    }

    try {
      setIsSaving(true);
      const { data, error } = await supabase
        .from('vehicle_types')
        .insert({
          name: formData.name.trim(),
          description: formData.description.trim() || null,
          slug: formData.slug.trim(),
          capacity: formData.capacity,
          categories: formData.categories,
          features: formData.features,
          is_active: formData.is_active,
          is_default: formData.is_default,
          driver_controllable: formData.driver_controllable,
          display_order: formData.display_order,
        })
        .select()
        .single();

      if (error) throw error;

      setVehicleTypes(prev => [...prev, data]);
      setIsAddDialogOpen(false);
      resetForm();
      toast.success('Vehicle type created successfully');
    } catch (err: any) {
      console.error('Error creating vehicle type:', err);
      if (err.code === '23505') {
        toast.error('A vehicle type with this code already exists');
      } else {
        toast.error('Failed to create vehicle type');
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleEdit = async () => {
    if (!selectedType) return;

    try {
      setIsSaving(true);
      const { error } = await supabase
        .from('vehicle_types')
        .update({
          name: formData.name.trim(),
          description: formData.description.trim() || null,
          slug: formData.slug.trim(),
          capacity: formData.capacity,
          categories: formData.categories,
          features: formData.features,
          is_active: formData.is_active,
          is_default: formData.is_default,
          driver_controllable: formData.driver_controllable,
          display_order: formData.display_order,
        })
        .eq('id', selectedType.id);

      if (error) throw error;

      setVehicleTypes(prev => prev.map(vt => 
        vt.id === selectedType.id 
          ? { ...vt, ...formData, description: formData.description || null }
          : vt
      ));
      setIsEditDialogOpen(false);
      setSelectedType(null);
      toast.success('Vehicle type updated successfully');
    } catch (err: any) {
      console.error('Error updating vehicle type:', err);
      if (err.code === '23505') {
        toast.error('A vehicle type with this code already exists');
      } else {
        toast.error('Failed to update vehicle type');
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedType) return;

    try {
      setIsSaving(true);
      const { error } = await supabase
        .from('vehicle_types')
        .delete()
        .eq('id', selectedType.id);

      if (error) throw error;

      setVehicleTypes(prev => prev.filter(vt => vt.id !== selectedType.id));
      setIsDeleteDialogOpen(false);
      setSelectedType(null);
      toast.success('Vehicle type deleted successfully');
    } catch (err) {
      console.error('Error deleting vehicle type:', err);
      toast.error('Failed to delete vehicle type. It may be in use.');
    } finally {
      setIsSaving(false);
    }
  };

  const openEditDialog = (type: VehicleType) => {
    setSelectedType(type);
    setFormData({
      name: type.name,
      description: type.description || '',
      slug: type.slug,
      capacity: type.capacity,
      categories: type.categories || ['Standard'],
      features: type.features || [],
      is_active: type.is_active,
      is_default: type.is_default,
      driver_controllable: type.driver_controllable,
      display_order: type.display_order || 0,
    });
    setIsEditDialogOpen(true);
  };

  const openDeleteDialog = (type: VehicleType) => {
    setSelectedType(type);
    setIsDeleteDialogOpen(true);
  };

  const filteredTypes = vehicleTypes.filter(type =>
    type.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    type.slug.toLowerCase().includes(searchQuery.toLowerCase()) ||
    type.description?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const activeCount = vehicleTypes.filter(t => t.is_active).length;
  const inactiveCount = vehicleTypes.filter(t => !t.is_active).length;

  const getFeatureBadgeColor = (feature: string) => {
    switch (feature.toLowerCase()) {
      case 'luxury': return 'bg-amber-100 text-amber-700 border-amber-200';
      case 'pet': return 'bg-yellow-100 text-yellow-700 border-yellow-200';
      case 'wheelchair': return 'bg-blue-100 text-blue-700 border-blue-200';
      case 'child seat': return 'bg-pink-100 text-pink-700 border-pink-200';
      case 'wifi': return 'bg-purple-100 text-purple-700 border-purple-200';
      case 'electric': return 'bg-emerald-100 text-emerald-700 border-emerald-200';
      default: return 'bg-gray-100 text-gray-700 border-gray-200';
    }
  };

  const FormContent = () => (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="name">Name *</Label>
          <Input
            id="name"
            value={formData.name}
            onChange={(e) => handleNameChange(e.target.value)}
            placeholder="e.g., Premium"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="slug">Code *</Label>
          <Input
            id="slug"
            value={formData.slug}
            onChange={(e) => setFormData(prev => ({ ...prev, slug: e.target.value }))}
            placeholder="e.g., premium"
            className="font-mono"
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="description">Description</Label>
        <Textarea
          id="description"
          value={formData.description}
          onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
          placeholder="Brief description of this vehicle type"
          rows={2}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="capacity">Passenger Capacity</Label>
          <Input
            id="capacity"
            type="number"
            min={1}
            max={20}
            value={formData.capacity}
            onChange={(e) => setFormData(prev => ({ ...prev, capacity: parseInt(e.target.value) || 4 }))}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="display_order">Display Order</Label>
          <Input
            id="display_order"
            type="number"
            min={0}
            value={formData.display_order}
            onChange={(e) => setFormData(prev => ({ ...prev, display_order: parseInt(e.target.value) || 0 }))}
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label>Categories</Label>
        <div className="flex flex-wrap gap-2">
          {CATEGORY_OPTIONS.map(category => (
            <Badge
              key={category}
              variant={formData.categories.includes(category) ? 'default' : 'outline'}
              className={`cursor-pointer transition-colors ${
                formData.categories.includes(category) 
                  ? 'bg-primary hover:bg-primary/90' 
                  : 'hover:bg-muted'
              }`}
              onClick={() => toggleCategory(category)}
            >
              {category}
            </Badge>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <Label>Features</Label>
        <div className="flex flex-wrap gap-2">
          {FEATURE_OPTIONS.map(feature => (
            <Badge
              key={feature}
              variant="outline"
              className={`cursor-pointer transition-colors ${
                formData.features.includes(feature) 
                  ? getFeatureBadgeColor(feature)
                  : 'hover:bg-muted'
              }`}
              onClick={() => toggleFeature(feature)}
            >
              {feature === 'Electric' ? <Zap className="h-3 w-3 mr-1" /> : <Sparkles className="h-3 w-3 mr-1" />}
              {feature}
            </Badge>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
        <div>
          <Label htmlFor="is_active" className="font-medium">Active Status</Label>
          <p className="text-xs text-muted-foreground">
            {formData.is_active ? 'Available for booking' : 'Hidden from customers'}
          </p>
        </div>
        <Switch
          id="is_active"
          checked={formData.is_active}
          onCheckedChange={(checked) => setFormData(prev => ({ ...prev, is_active: checked }))}
        />
      </div>
    </div>
  );

  return (
    <AdminLayout
      title="Vehicle Types"
      description="Manage vehicle categories available for booking"
    >
      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Total Types</p>
                <p className="text-2xl font-bold">{vehicleTypes.length}</p>
              </div>
              <Car className="h-8 w-8 text-primary opacity-80" />
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
              <CheckCircle2 className="h-8 w-8 text-green-500" />
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
              <XCircle className="h-8 w-8 text-gray-400" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Main Content */}
      <Card>
        <CardHeader className="pb-4">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <CardTitle className="flex items-center gap-2">
              <Car className="h-5 w-5 text-primary" />
              Vehicle Types
            </CardTitle>
            <div className="flex items-center gap-3">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search vehicle types..."
                  className="pl-9 w-[250px]"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
              <Button onClick={() => { resetForm(); setIsAddDialogOpen(true); }}>
                <Plus className="h-4 w-4 mr-2" />
                Add Vehicle Type
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
          ) : filteredTypes.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              {searchQuery ? 'No vehicle types match your search' : 'No vehicle types configured'}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Code</TableHead>
                  <TableHead>Capacity</TableHead>
                  <TableHead>Categories</TableHead>
                  <TableHead>Features</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredTypes.map((type) => (
                  <TableRow key={type.id}>
                    <TableCell>
                      <div>
                        <p className="font-medium">{type.name}</p>
                        {type.description && (
                          <p className="text-sm text-muted-foreground line-clamp-2">
                            {type.description}
                          </p>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="font-mono text-xs">
                        {type.slug}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Users className="h-4 w-4 text-muted-foreground" />
                        <span>{type.capacity}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {type.categories?.map(cat => (
                          <Badge key={cat} variant="secondary" className="text-xs">
                            {cat}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {type.features?.length > 0 ? (
                          type.features.map(feat => (
                            <Badge 
                              key={feat} 
                              variant="outline" 
                              className={`text-xs ${getFeatureBadgeColor(feat)}`}
                            >
                              {feat}
                            </Badge>
                          ))
                        ) : (
                          <span className="text-muted-foreground text-sm">—</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge 
                        variant={type.is_active ? 'default' : 'secondary'}
                        className={type.is_active ? 'bg-green-500 hover:bg-green-600' : ''}
                      >
                        {type.is_active ? 'Active' : 'Inactive'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => openEditDialog(type)}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-destructive hover:text-destructive"
                          onClick={() => openDeleteDialog(type)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Add Dialog */}
      <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Plus className="h-5 w-5" />
              Add Vehicle Type
            </DialogTitle>
            <DialogDescription>
              Create a new vehicle category for your fleet
            </DialogDescription>
          </DialogHeader>
          <FormContent />
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsAddDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleAdd} disabled={isSaving}>
              {isSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="h-5 w-5" />
              Edit Vehicle Type
            </DialogTitle>
            <DialogDescription>
              Update vehicle type settings
            </DialogDescription>
          </DialogHeader>
          <FormContent />
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsEditDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleEdit} disabled={isSaving}>
              {isSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Vehicle Type</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{selectedType?.name}"? This action cannot be undone
              and may affect existing pricing configurations.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AdminLayout>
  );
}
