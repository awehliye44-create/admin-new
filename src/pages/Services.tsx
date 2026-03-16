import { useEffect, useState, useCallback } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
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
import { ServiceAreaBoundaryMap } from '@/components/maps/ServiceAreaBoundaryMap';
import { supabase } from '@/integrations/supabase/client';
import { 
  Plus, Navigation, Loader2, MoreHorizontal, Pencil, Trash2, MapPin, Search, Users, DollarSign,
  Ruler, Globe, CheckCircle2, XCircle, Eye, Settings, Car, Clock, Map
} from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { useNavigate } from 'react-router-dom';
import { getCurrencySymbol } from '@/lib/regionSettings';

interface LatLng {
  lat: number;
  lng: number;
}

interface GeoJSON {
  type: string;
  coordinates: number[][][];
}

interface Region {
  id: string;
  name: string;
  distance_unit: string;
  currency_code: string;
  timezone: string;
  status: string;
  geo_boundary?: any;
}

interface ServiceArea {
  id: string;
  name: string;
  code: string | null;
  country: string | null;
  timezone: string;
  currency_code: string;
  distance_unit: string;
  region_id: string;
  is_active: boolean;
  geo_boundary?: any;
  created_at: string;
  updated_at: string;
  region?: Region;
}

interface PricingStatus {
  vehicleTypesConfigured: number;
  totalVehicleTypes: number;
  hasBaseFare: boolean;
  hasCancellationFees: boolean;
}

const CURRENCIES: Record<string, { symbol: string; name: string }> = {
  GBP: { symbol: '£', name: 'British Pound' },
  USD: { symbol: '$', name: 'US Dollar' },
  EUR: { symbol: '€', name: 'Euro' },
  CAD: { symbol: 'C$', name: 'Canadian Dollar' },
  AUD: { symbol: 'A$', name: 'Australian Dollar' },
  NZD: { symbol: 'NZ$', name: 'New Zealand Dollar' },
  INR: { symbol: '₹', name: 'Indian Rupee' },
  AED: { symbol: 'د.إ', name: 'UAE Dirham' },
  NGN: { symbol: '₦', name: 'Nigerian Naira' },
  KES: { symbol: 'KSh', name: 'Kenyan Shilling' },
  ZAR: { symbol: 'R', name: 'South African Rand' },
  SGD: { symbol: 'S$', name: 'Singapore Dollar' },
  JPY: { symbol: '¥', name: 'Japanese Yen' },
};

const TIMEZONES = [
  { value: 'Europe/London', label: 'London (GMT/BST)' },
  { value: 'Europe/Paris', label: 'Paris (CET/CEST)' },
  { value: 'Europe/Berlin', label: 'Berlin (CET/CEST)' },
  { value: 'America/New_York', label: 'New York (EST/EDT)' },
  { value: 'America/Chicago', label: 'Chicago (CST/CDT)' },
  { value: 'America/Los_Angeles', label: 'Los Angeles (PST/PDT)' },
  { value: 'Africa/Lagos', label: 'Lagos (WAT)' },
  { value: 'Africa/Nairobi', label: 'Nairobi (EAT)' },
  { value: 'Africa/Johannesburg', label: 'Johannesburg (SAST)' },
  { value: 'Asia/Dubai', label: 'Dubai (GST)' },
  { value: 'Asia/Singapore', label: 'Singapore (SGT)' },
  { value: 'Asia/Tokyo', label: 'Tokyo (JST)' },
  { value: 'Australia/Sydney', label: 'Sydney (AEST/AEDT)' },
  { value: 'Australia/Perth', label: 'Perth (AWST)' },
  { value: 'Pacific/Auckland', label: 'Auckland (NZST/NZDT)' },
];

export default function Services() {
  const navigate = useNavigate();
  const [serviceAreas, setServiceAreas] = useState<ServiceArea[]>([]);
  const [regions, setRegions] = useState<Region[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [regionFilter, setRegionFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  // Dialog states
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isViewDialogOpen, setIsViewDialogOpen] = useState(false);
  const [selectedArea, setSelectedArea] = useState<ServiceArea | null>(null);

  // Form states
  const [formData, setFormData] = useState<{ 
    name: string; 
    code: string;
    country: string;
    timezone: string;
    currency_code: string;
    distance_unit: string;
    region_id: string; 
    is_active: boolean; 
    geo_boundary: any 
  }>({ 
    name: '', 
    code: '',
    country: '',
    timezone: 'Europe/London',
    currency_code: 'GBP',
    distance_unit: 'km',
    region_id: '', 
    is_active: true,
    geo_boundary: null,
  });
  const [isSaving, setIsSaving] = useState(false);
  const [activeTab, setActiveTab] = useState('details');

  // Stats
  const [driverCounts, setDriverCounts] = useState<Record<string, number>>({});
  const [pricingStatus, setPricingStatus] = useState<Record<string, PricingStatus>>({});

  const resetFormData = () => {
    setFormData({
      name: '',
      code: '',
      country: '',
      timezone: 'Europe/London',
      currency_code: 'GBP',
      distance_unit: 'km',
      region_id: regions[0]?.id || '',
      is_active: true,
      geo_boundary: null,
    });
  };

  const fetchData = async () => {
    try {
      setIsLoading(true);
      
      const [areasRes, regionsRes, vehicleTypesRes] = await Promise.all([
        supabase
          .from('service_areas')
          .select(`*, region:regions(id, name, distance_unit, currency_code, timezone, status, geo_boundary)`)
          .order('name', { ascending: true }),
        supabase
          .from('regions')
          .select('id, name, distance_unit, currency_code, timezone, status, geo_boundary')
          .order('name', { ascending: true }),
        supabase
          .from('vehicle_types')
          .select('id')
          .eq('is_active', true),
      ]);

      if (areasRes.error) throw areasRes.error;
      if (regionsRes.error) throw regionsRes.error;

      setServiceAreas(areasRes.data || []);
      setRegions(regionsRes.data || []);

      const totalVehicleTypes = vehicleTypesRes.data?.length || 0;

      // Fetch pricing status and driver counts
      if (areasRes.data && areasRes.data.length > 0) {
        const areaIds = areasRes.data.map(a => a.id);
        
        const [driverServiceAreasRes, pricingRes, cancellationRes, vehicleAssignRes] = await Promise.all([
          supabase.from('driver_service_areas').select('service_area_id'),
          supabase.from('fare_pricing_settings').select('service_area_id, base_fare_pence').in('service_area_id', areaIds),
          supabase.from('service_area_cancellation_fees').select('service_area_id').in('service_area_id', areaIds),
          supabase.from('service_area_vehicle_types').select('service_area_id').eq('is_active', true).in('service_area_id', areaIds),
        ]);

        // Count drivers per area
        if (driverServiceAreasRes.data) {
          const counts: Record<string, number> = {};
          driverServiceAreasRes.data.forEach(dsa => {
            counts[dsa.service_area_id] = (counts[dsa.service_area_id] || 0) + 1;
          });
          setDriverCounts(counts);
        }

        // Count assigned vehicle types per area
        const vtCounts: Record<string, number> = {};
        (vehicleAssignRes.data || []).forEach((row: any) => {
          vtCounts[row.service_area_id] = (vtCounts[row.service_area_id] || 0) + 1;
        });

        // Build pricing status from Fare Engine settings + vehicle type assignments
        const status: Record<string, PricingStatus> = {};
        areasRes.data.forEach(area => {
          const fareEngineConfig = pricingRes.data?.find(p => p.service_area_id === area.id);
          const hasCancellation = cancellationRes.data?.some(c => c.service_area_id === area.id) || false;
          
          status[area.id] = {
            vehicleTypesConfigured: vtCounts[area.id] || 0,
            totalVehicleTypes,
            hasBaseFare: fareEngineConfig ? fareEngineConfig.base_fare_pence > 0 : false,
            hasCancellationFees: hasCancellation,
          };
        });
        setPricingStatus(status);
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
    if (!formData.code.trim()) {
      toast.error('Please enter an area code (e.g., NYC, LON, DXB)');
      return;
    }
    if (!formData.region_id) {
      toast.error('Please select a region');
      return;
    }

    // Convert GeoJSON boundary to LatLng array for DB trigger validation
    const boundaryForDb = formData.geo_boundary
      ? formData.geo_boundary.type === 'Polygon' && formData.geo_boundary.coordinates?.[0]
        ? formData.geo_boundary.coordinates[0].slice(0, -1).map((c: number[]) => ({ lat: c[1], lng: c[0] }))
        : formData.geo_boundary
      : null;

    setIsSaving(true);
    try {
      const { data, error } = await supabase
        .from('service_areas')
        .insert({ 
          name: formData.name,
          code: formData.code.toUpperCase(),
          country: formData.country || null,
          timezone: formData.timezone,
          currency_code: formData.currency_code,
          distance_unit: formData.distance_unit,
          region_id: formData.region_id, 
          is_active: formData.is_active,
          geo_boundary: boundaryForDb,
        })
        .select(`*, region:regions(id, name, distance_unit, currency_code, timezone, status, geo_boundary)`)
        .single();

      if (error) throw error;

      setServiceAreas(prev => [...prev, data].sort((a, b) => a.name.localeCompare(b.name)));
      setPricingStatus(prev => ({
        ...prev,
        [data.id]: { vehicleTypesConfigured: 0, totalVehicleTypes: 0, hasBaseFare: false, hasCancellationFees: false }
      }));
      toast.success('Service area created successfully');
      setIsAddDialogOpen(false);
      resetFormData();
      setActiveTab('details');
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

    // Convert GeoJSON boundary to LatLng array for DB trigger validation
    const boundaryForDb = formData.geo_boundary
      ? formData.geo_boundary.type === 'Polygon' && formData.geo_boundary.coordinates?.[0]
        ? formData.geo_boundary.coordinates[0].slice(0, -1).map((c: number[]) => ({ lat: c[1], lng: c[0] }))
        : formData.geo_boundary
      : null;

    setIsSaving(true);
    try {
      const { data, error } = await supabase
        .from('service_areas')
        .update({ 
          name: formData.name,
          code: formData.code.toUpperCase(),
          country: formData.country || null,
          timezone: formData.timezone,
          currency_code: formData.currency_code,
          distance_unit: formData.distance_unit,
          region_id: formData.region_id, 
          is_active: formData.is_active,
          geo_boundary: boundaryForDb,
        })
        .eq('id', selectedArea.id)
        .select(`*, region:regions(id, name, distance_unit, currency_code, timezone, status, geo_boundary)`)
        .single();

      if (error) throw error;

      setServiceAreas(prev =>
        prev.map(a => a.id === selectedArea.id ? data : a).sort((a, b) => a.name.localeCompare(b.name))
      );
      toast.success('Service area updated successfully');
      setIsEditDialogOpen(false);
      setSelectedArea(null);
      setActiveTab('details');
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
    setFormData({ 
      name: area.name, 
      code: area.code || '',
      country: area.country || '',
      timezone: area.timezone || 'Europe/London',
      currency_code: area.currency_code || 'GBP',
      distance_unit: area.distance_unit || 'km',
      region_id: area.region_id, 
      is_active: area.is_active, 
      geo_boundary: area.geo_boundary || null 
    });
    setActiveTab('details');
    setIsEditDialogOpen(true);
  };

  const openViewDialog = (area: ServiceArea) => {
    setSelectedArea(area);
    setIsViewDialogOpen(true);
  };

  const openDeleteDialog = (area: ServiceArea) => {
    setSelectedArea(area);
    setIsDeleteDialogOpen(true);
  };

  // getCurrencySymbol imported from regionSettings

  const getSelectedRegion = () => regions.find(r => r.id === formData.region_id);

  const filteredAreas = serviceAreas.filter(area => {
    const matchesSearch = area.name.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesRegion = regionFilter === 'all' || area.region_id === regionFilter;
    const matchesStatus = statusFilter === 'all' || 
      (statusFilter === 'active' && area.is_active) || 
      (statusFilter === 'inactive' && !area.is_active);
    return matchesSearch && matchesRegion && matchesStatus;
  });

  const activeCount = serviceAreas.filter(a => a.is_active).length;
  const inactiveCount = serviceAreas.filter(a => !a.is_active).length;
  const configuredCount = Object.values(pricingStatus).filter(p => p.vehicleTypesConfigured > 0).length;

  return (
    <AdminLayout 
      title="Service Areas" 
      description="Service controls pricing - Configure fares per service area"
    >
      {/* Key Principle Banner */}
      <Card className="mb-6 bg-primary/5 border-primary/20">
        <CardContent className="py-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-full bg-primary/10">
              <DollarSign className="h-5 w-5 text-primary" />
            </div>
            <div>
              <p className="font-medium text-primary">Key Principle</p>
              <p className="text-sm text-muted-foreground">
                <strong>Region</strong> controls availability. <strong>Service</strong> controls pricing. <strong>Driver</strong> controls supply.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-4 mb-6">
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
        <Card className="border-blue-500/30 bg-blue-500/5">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Pricing Set</p>
                <p className="text-2xl font-bold text-blue-600">{configuredCount}</p>
              </div>
              <DollarSign className="h-8 w-8 text-blue-500" />
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
              <Globe className="h-8 w-8 text-purple-500 opacity-80" />
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Navigation className="h-5 w-5 text-primary" />
              All Service Areas
            </CardTitle>
            <CardDescription>
              Each service area inherits settings from its region
            </CardDescription>
          </div>
          <div className="flex flex-col gap-2 md:flex-row md:items-center">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search areas..."
                className="pl-9 w-full md:w-[180px]"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
            <Select value={regionFilter} onValueChange={setRegionFilter}>
              <SelectTrigger className="w-full md:w-[160px]">
                <SelectValue placeholder="All Regions" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Regions</SelectItem>
                {regions.map(region => (
                  <SelectItem key={region.id} value={region.id}>{region.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-full md:w-[120px]">
                <SelectValue placeholder="All Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="inactive">Inactive</SelectItem>
              </SelectContent>
            </Select>
            <Button onClick={() => {
              resetFormData();
              setActiveTab('details');
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
            <div className="py-12 text-center">
              <Navigation className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-lg font-medium mb-2">No service areas found</h3>
              <p className="text-muted-foreground mb-4">
                {searchQuery || regionFilter !== 'all' || statusFilter !== 'all'
                  ? 'Try adjusting your filters'
                  : 'Create your first service area to start configuring pricing'}
              </p>
              {!searchQuery && regionFilter === 'all' && statusFilter === 'all' && (
                <Button onClick={() => {
                  resetFormData();
                  setActiveTab('details');
                  setIsAddDialogOpen(true);
                }}>
                  <Plus className="mr-2 h-4 w-4" />
                  Create First Area
                </Button>
              )}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Service Area</TableHead>
                  <TableHead>Region</TableHead>
                  <TableHead>Inherited Settings</TableHead>
                  <TableHead>Pricing Status</TableHead>
                  <TableHead>Drivers</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredAreas.map((area) => {
                  const pricing = pricingStatus[area.id];
                  return (
                    <TableRow key={area.id}>
                      <TableCell>
                        <div className="font-medium">{area.name}</div>
                        <div className="text-xs text-muted-foreground">
                          Created {format(new Date(area.created_at), 'MMM d, yyyy')}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={
                          area.region?.status === 'active' 
                            ? 'border-green-200 bg-green-50 text-green-700'
                            : 'border-gray-200 bg-gray-50 text-gray-600'
                        }>
                          {area.region?.name || 'Unknown'}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {area.region && (
                          <div className="flex flex-col gap-1 text-sm">
                            <span className="flex items-center gap-1 text-muted-foreground">
                              <DollarSign className="h-3 w-3" />
                              {getCurrencySymbol(area.region.currency_code)} {area.region.currency_code}
                            </span>
                            <span className="flex items-center gap-1 text-muted-foreground">
                              <Ruler className="h-3 w-3" />
                              {area.region.distance_unit === 'mile' ? 'Miles' : 'Kilometers'}
                            </span>
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        {pricing ? (
                          <div className="space-y-1">
                            {pricing.vehicleTypesConfigured > 0 ? (
                              <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200">
                                <Car className="h-3 w-3 mr-1" />
                                {pricing.vehicleTypesConfigured} vehicle types
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="bg-orange-50 text-orange-700 border-orange-200">
                                <XCircle className="h-3 w-3 mr-1" />
                                Not configured
                              </Badge>
                            )}
                            {pricing.hasCancellationFees && (
                              <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200 ml-1">
                                <Clock className="h-3 w-3 mr-1" />
                                Cancellation fees
                              </Badge>
                            )}
                          </div>
                        ) : (
                          <span className="text-muted-foreground text-sm">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <Users className="h-4 w-4 text-muted-foreground" />
                          <span>{driverCounts[area.id] || 0}</span>
                        </div>
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
                      <TableCell className="text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => openViewDialog(area)}>
                              <Eye className="mr-2 h-4 w-4" />
                              View Details
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => navigate(`/service-area-pricing?id=${area.id}`)}>
                              <DollarSign className="mr-2 h-4 w-4" />
                              Configure Pricing
                            </DropdownMenuItem>
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
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Add Service Area Dialog */}
      <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Navigation className="h-5 w-5" />
              Add New Service Area
            </DialogTitle>
            <DialogDescription>
              Create a new service area with boundary - it will inherit settings from the selected region
            </DialogDescription>
          </DialogHeader>
          
          <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="details">Details</TabsTrigger>
              <TabsTrigger value="boundary" disabled={!formData.region_id}>
                <Map className="h-4 w-4 mr-2" />
                Boundary
              </TabsTrigger>
            </TabsList>
            
            <TabsContent value="details" className="space-y-4 py-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="name">Area Name *</Label>
                  <Input
                    id="name"
                    placeholder="e.g., Central London, Manhattan"
                    value={formData.name}
                    onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                  />
                </div>
                
                <div className="space-y-2">
                  <Label htmlFor="code">Area Code *</Label>
                  <Input
                    id="code"
                    placeholder="e.g., LON, NYC, DXB"
                    value={formData.code}
                    onChange={(e) => setFormData(prev => ({ ...prev, code: e.target.value.toUpperCase().slice(0, 5) }))}
                    maxLength={5}
                    className="uppercase"
                  />
                  <p className="text-xs text-muted-foreground">Used for trip numbers (e.g., NYC0001)</p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="country">Country</Label>
                  <Input
                    id="country"
                    placeholder="e.g., United Kingdom, USA"
                    value={formData.country}
                    onChange={(e) => setFormData(prev => ({ ...prev, country: e.target.value }))}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="region">Region *</Label>
                  <Select
                    value={formData.region_id}
                    onValueChange={(value) => {
                      const region = regions.find(r => r.id === value);
                      setFormData(prev => ({ 
                        ...prev, 
                        region_id: value, 
                        geo_boundary: null,
                        currency_code: region?.currency_code || prev.currency_code,
                        distance_unit: region?.distance_unit || prev.distance_unit,
                        timezone: region?.timezone || prev.timezone,
                      }));
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select a region" />
                    </SelectTrigger>
                    <SelectContent>
                      {regions.map(region => (
                        <SelectItem key={region.id} value={region.id}>
                          {region.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>


              {getSelectedRegion() && (
                <Card className="bg-muted/50">
                  <CardContent className="pt-4">
                    <p className="text-sm font-medium mb-3">Inherited from Region</p>
                    <div className="grid grid-cols-3 gap-3 text-sm">
                      <div className="flex items-center gap-2">
                        <DollarSign className="h-4 w-4 text-muted-foreground" />
                        <span>Currency: <strong>{getCurrencySymbol(getSelectedRegion()!.currency_code)} {getSelectedRegion()!.currency_code}</strong></span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Ruler className="h-4 w-4 text-muted-foreground" />
                        <span>Distance: <strong>{getSelectedRegion()!.distance_unit === 'mile' ? 'Miles' : 'Kilometers'}</strong></span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Clock className="h-4 w-4 text-muted-foreground" />
                        <span>TZ: <strong>{getSelectedRegion()!.timezone}</strong></span>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}

              <div className="flex items-center justify-between pt-2">
                <div>
                  <Label htmlFor="is_active">Active Status</Label>
                  <p className="text-xs text-muted-foreground">Only active areas accept rides</p>
                </div>
                <Switch
                  id="is_active"
                  checked={formData.is_active}
                  onCheckedChange={(checked) => setFormData(prev => ({ ...prev, is_active: checked }))}
                />
              </div>
            </TabsContent>
            
            <TabsContent value="boundary" className="py-4">
              {getSelectedRegion() && (
                <ServiceAreaBoundaryMap
                  boundary={formData.geo_boundary}
                  region={getSelectedRegion() ? { 
                    id: getSelectedRegion()!.id, 
                    name: getSelectedRegion()!.name, 
                    geo_boundary: getSelectedRegion()!.geo_boundary 
                  } : null}
                  onBoundaryChange={(boundary) => setFormData(prev => ({ ...prev, geo_boundary: boundary }))}
                  isEditable={true}
                  height="400px"
                />
              )}
              {!getSelectedRegion() && (
                <div className="text-center py-12 text-muted-foreground">
                  <Map className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p>Please select a region first to draw the boundary</p>
                </div>
              )}
            </TabsContent>
          </Tabs>

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
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="h-5 w-5" />
              Edit Service Area
            </DialogTitle>
            <DialogDescription>
              Update service area information and boundary
            </DialogDescription>
          </DialogHeader>
          
          <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="details">Details</TabsTrigger>
              <TabsTrigger value="boundary">
                <Map className="h-4 w-4 mr-2" />
                Boundary
              </TabsTrigger>
            </TabsList>
            
            <TabsContent value="details" className="space-y-4 py-4">
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
                  onValueChange={(value) => {
                    const region = regions.find(r => r.id === value);
                    setFormData(prev => ({ 
                      ...prev, 
                      region_id: value, 
                      geo_boundary: null,
                      currency_code: region?.currency_code || prev.currency_code,
                      distance_unit: region?.distance_unit || prev.distance_unit,
                      timezone: region?.timezone || prev.timezone,
                    }));
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {regions.map(region => (
                      <SelectItem key={region.id} value={region.id}>
                        <span className="flex items-center gap-2">
                          {region.name}
                          <span className="text-muted-foreground text-xs">
                            ({getCurrencySymbol(region.currency_code)}, {region.distance_unit === 'mile' ? 'mi' : 'km'})
                          </span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {getSelectedRegion() && (
                <Card className="bg-muted/50">
                  <CardContent className="pt-4">
                    <p className="text-sm font-medium mb-3">Inherited from Region</p>
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <div className="flex items-center gap-2">
                        <DollarSign className="h-4 w-4 text-muted-foreground" />
                        <span>Currency: <strong>{getCurrencySymbol(getSelectedRegion()!.currency_code)} {getSelectedRegion()!.currency_code}</strong></span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Ruler className="h-4 w-4 text-muted-foreground" />
                        <span>Distance: <strong>{getSelectedRegion()!.distance_unit === 'mile' ? 'Miles' : 'Kilometers'}</strong></span>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}

              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="edit_is_active">Active Status</Label>
                  <p className="text-xs text-muted-foreground">Only active areas accept rides</p>
                </div>
                <Switch
                  id="edit_is_active"
                  checked={formData.is_active}
                  onCheckedChange={(checked) => setFormData(prev => ({ ...prev, is_active: checked }))}
                />
              </div>
            </TabsContent>
            
            <TabsContent value="boundary" className="py-4">
              {getSelectedRegion() && (
                <ServiceAreaBoundaryMap
                  boundary={formData.geo_boundary}
                  region={{ id: getSelectedRegion()!.id, name: getSelectedRegion()!.name, geo_boundary: getSelectedRegion()!.geo_boundary }}
                  onBoundaryChange={(boundary) => setFormData(prev => ({ ...prev, geo_boundary: boundary }))}
                  isEditable={true}
                  height="400px"
                />
              )}
            </TabsContent>
          </Tabs>

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

      {/* View Service Area Dialog */}
      <Dialog open={isViewDialogOpen} onOpenChange={setIsViewDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Navigation className="h-5 w-5" />
              {selectedArea?.name}
            </DialogTitle>
            <DialogDescription>
              Service area details and inherited settings
            </DialogDescription>
          </DialogHeader>
          
          {selectedArea && (
            <div className="space-y-4">
              {/* Status */}
              <div className="flex items-center justify-between p-4 bg-muted/50 rounded-lg">
                <span className="font-medium">Status</span>
                <Badge className={selectedArea.is_active ? 'bg-green-500' : 'bg-gray-500'}>
                  {selectedArea.is_active ? 'Active' : 'Inactive'}
                </Badge>
              </div>

              {/* Region Info */}
              {selectedArea.region && (
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-sm font-medium flex items-center gap-2">
                      <Globe className="h-4 w-4" />
                      Region: {selectedArea.region.name}
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="p-3 bg-muted/50 rounded-lg">
                        <p className="text-xs text-muted-foreground">Currency</p>
                        <p className="font-medium">{getCurrencySymbol(selectedArea.region.currency_code)} {selectedArea.region.currency_code}</p>
                      </div>
                      <div className="p-3 bg-muted/50 rounded-lg">
                        <p className="text-xs text-muted-foreground">Distance Unit</p>
                        <p className="font-medium">{selectedArea.region.distance_unit === 'mile' ? 'Miles' : 'Kilometers'}</p>
                      </div>
                      <div className="p-3 bg-muted/50 rounded-lg">
                        <p className="text-xs text-muted-foreground">Timezone</p>
                        <p className="font-medium">{selectedArea.region.timezone}</p>
                      </div>
                      <div className="p-3 bg-muted/50 rounded-lg">
                        <p className="text-xs text-muted-foreground">Region Status</p>
                        <Badge className={selectedArea.region.status === 'active' ? 'bg-green-500' : 'bg-gray-500'}>
                          {selectedArea.region.status}
                        </Badge>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Pricing Status */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <DollarSign className="h-4 w-4" />
                    Pricing Configuration
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {pricingStatus[selectedArea.id] ? (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-sm">Vehicle Types Configured</span>
                        <Badge variant="outline">
                          {pricingStatus[selectedArea.id].vehicleTypesConfigured} / {pricingStatus[selectedArea.id].totalVehicleTypes}
                        </Badge>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-sm">Cancellation Fees</span>
                        {pricingStatus[selectedArea.id].hasCancellationFees ? (
                          <Badge className="bg-green-500">Configured</Badge>
                        ) : (
                          <Badge variant="outline">Not Set</Badge>
                        )}
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">No pricing configured yet</p>
                  )}
                </CardContent>
              </Card>

              {/* Stats */}
              <div className="grid grid-cols-2 gap-4">
                <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
                  <p className="text-sm text-blue-600">Assigned Drivers</p>
                  <p className="text-2xl font-bold text-blue-700">{driverCounts[selectedArea.id] || 0}</p>
                </div>
                <div className="p-4 bg-purple-50 rounded-lg border border-purple-200">
                  <p className="text-sm text-purple-600">Created</p>
                  <p className="text-sm font-medium text-purple-700">
                    {format(new Date(selectedArea.created_at), 'MMM d, yyyy')}
                  </p>
                </div>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsViewDialogOpen(false)}>
              Close
            </Button>
            <Button onClick={() => {
              setIsViewDialogOpen(false);
              if (selectedArea) navigate(`/service-area-pricing?id=${selectedArea.id}`);
            }}>
              <DollarSign className="mr-2 h-4 w-4" />
              Configure Pricing
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
              All pricing configurations and driver assignments will be removed.
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
