import { useEffect, useState } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
import { RegionBoundaryMap } from '@/components/maps/RegionBoundaryMap';
import { supabase } from '@/integrations/supabase/client';
import { 
  Plus, MapPin, Loader2, MoreHorizontal, Pencil, Trash2, Globe, Users, Map,
  DollarSign, Clock, Ruler, CheckCircle2, XCircle, Eye, Settings, CreditCard
} from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';


interface LatLng {
  lat: number;
  lng: number;
}

interface Region {
  id: string;
  name: string;
  status: string;
  distance_unit: string;
  currency_code: string;
  timezone: string;
  geo_boundary: LatLng[] | null;
  created_at: string;
  updated_at: string;
}

interface RegionStats {
  drivers: number;
  serviceAreas: number;
}

interface RegionFormData {
  name: string;
  status: string;
  distance_unit: string;
  currency_code: string;
  timezone: string;
  geo_boundary: LatLng[] | null;
}

const DEFAULT_FORM_DATA: RegionFormData = {
  name: '',
  status: 'active',
  distance_unit: 'mile',
  currency_code: 'GBP',
  timezone: 'Europe/London',
  geo_boundary: null,
};

// Use shared CURRENCY_LIST from regionSettings — single source of truth
import { CURRENCY_LIST } from '@/lib/regionSettings';

const CURRENCIES = CURRENCY_LIST;

const TIMEZONES = [
  // Americas
  { value: 'America/New_York', label: 'New York (EST/EDT)' },
  { value: 'America/Los_Angeles', label: 'Los Angeles (PST/PDT)' },
  { value: 'America/Chicago', label: 'Chicago (CST/CDT)' },
  { value: 'America/Toronto', label: 'Toronto (EST/EDT)' },
  { value: 'America/Vancouver', label: 'Vancouver (PST/PDT)' },
  { value: 'America/Mexico_City', label: 'Mexico City (CST/CDT)' },
  { value: 'America/Sao_Paulo', label: 'São Paulo (BRT)' },
  { value: 'America/Buenos_Aires', label: 'Buenos Aires (ART)' },
  { value: 'America/Lima', label: 'Lima (PET)' },
  { value: 'America/Bogota', label: 'Bogota (COT)' },
  // Europe
  { value: 'Europe/London', label: 'London (GMT/BST)' },
  { value: 'Europe/Paris', label: 'Paris (CET/CEST)' },
  { value: 'Europe/Berlin', label: 'Berlin (CET/CEST)' },
  { value: 'Europe/Madrid', label: 'Madrid (CET/CEST)' },
  { value: 'Europe/Rome', label: 'Rome (CET/CEST)' },
  { value: 'Europe/Amsterdam', label: 'Amsterdam (CET/CEST)' },
  { value: 'Europe/Brussels', label: 'Brussels (CET/CEST)' },
  { value: 'Europe/Zurich', label: 'Zurich (CET/CEST)' },
  { value: 'Europe/Vienna', label: 'Vienna (CET/CEST)' },
  { value: 'Europe/Warsaw', label: 'Warsaw (CET/CEST)' },
  { value: 'Europe/Prague', label: 'Prague (CET/CEST)' },
  { value: 'Europe/Stockholm', label: 'Stockholm (CET/CEST)' },
  { value: 'Europe/Oslo', label: 'Oslo (CET/CEST)' },
  { value: 'Europe/Copenhagen', label: 'Copenhagen (CET/CEST)' },
  { value: 'Europe/Helsinki', label: 'Helsinki (EET/EEST)' },
  { value: 'Europe/Athens', label: 'Athens (EET/EEST)' },
  { value: 'Europe/Istanbul', label: 'Istanbul (TRT)' },
  { value: 'Europe/Moscow', label: 'Moscow (MSK)' },
  { value: 'Europe/Kiev', label: 'Kyiv (EET/EEST)' },
  // Middle East
  { value: 'Asia/Dubai', label: 'Dubai (GST)' },
  { value: 'Asia/Riyadh', label: 'Riyadh (AST)' },
  { value: 'Asia/Qatar', label: 'Doha (AST)' },
  { value: 'Asia/Kuwait', label: 'Kuwait (AST)' },
  { value: 'Asia/Bahrain', label: 'Bahrain (AST)' },
  { value: 'Asia/Jerusalem', label: 'Jerusalem (IST)' },
  { value: 'Africa/Cairo', label: 'Cairo (EET)' },
  // Asia
  { value: 'Asia/Kolkata', label: 'India (IST)' },
  { value: 'Asia/Karachi', label: 'Karachi (PKT)' },
  { value: 'Asia/Dhaka', label: 'Dhaka (BST)' },
  { value: 'Asia/Colombo', label: 'Colombo (IST)' },
  { value: 'Asia/Kathmandu', label: 'Kathmandu (NPT)' },
  { value: 'Asia/Bangkok', label: 'Bangkok (ICT)' },
  { value: 'Asia/Jakarta', label: 'Jakarta (WIB)' },
  { value: 'Asia/Singapore', label: 'Singapore (SGT)' },
  { value: 'Asia/Kuala_Lumpur', label: 'Kuala Lumpur (MYT)' },
  { value: 'Asia/Manila', label: 'Manila (PHT)' },
  { value: 'Asia/Ho_Chi_Minh', label: 'Ho Chi Minh (ICT)' },
  { value: 'Asia/Hong_Kong', label: 'Hong Kong (HKT)' },
  { value: 'Asia/Shanghai', label: 'Shanghai (CST)' },
  { value: 'Asia/Taipei', label: 'Taipei (CST)' },
  { value: 'Asia/Seoul', label: 'Seoul (KST)' },
  { value: 'Asia/Tokyo', label: 'Tokyo (JST)' },
  // Australia & Pacific
  { value: 'Australia/Sydney', label: 'Sydney (AEST/AEDT)' },
  { value: 'Australia/Melbourne', label: 'Melbourne (AEST/AEDT)' },
  { value: 'Australia/Brisbane', label: 'Brisbane (AEST)' },
  { value: 'Australia/Perth', label: 'Perth (AWST)' },
  { value: 'Pacific/Auckland', label: 'Auckland (NZST/NZDT)' },
  // Africa
  { value: 'Africa/Johannesburg', label: 'Johannesburg (SAST)' },
  { value: 'Africa/Lagos', label: 'Lagos (WAT)' },
  { value: 'Africa/Nairobi', label: 'Nairobi (EAT)' },
  { value: 'Africa/Casablanca', label: 'Casablanca (WET)' },
  { value: 'Africa/Accra', label: 'Accra (GMT)' },
];

export default function Regions() {
  const [regions, setRegions] = useState<Region[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Dialog states
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isViewDialogOpen, setIsViewDialogOpen] = useState(false);
  const [selectedRegion, setSelectedRegion] = useState<Region | null>(null);

  // Form states
  const [formData, setFormData] = useState<RegionFormData>(DEFAULT_FORM_DATA);
  const [isSaving, setIsSaving] = useState(false);
  const [activeTab, setActiveTab] = useState('details');

  // Stats
  const [regionStats, setRegionStats] = useState<Record<string, RegionStats>>({});

  const fetchRegions = async (isBackground = false) => {
    try {
      if (!isBackground) setIsLoading(true);
      const { data, error } = await supabase
        .from('regions')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) throw error;
      
      // Parse geo_boundary if it's a string
      const parsedData = (data || []).map(region => ({
        ...region,
        geo_boundary: region.geo_boundary 
          ? (typeof region.geo_boundary === 'string' 
              ? JSON.parse(region.geo_boundary) 
              : region.geo_boundary)
          : null,
      }));
      
      setRegions(parsedData);

      // Fetch all stats in parallel (not N+1)
      if (parsedData.length > 0) {
        const regionIds = parsedData.map(r => r.id);
        const [driversRes, areasRes] = await Promise.all([
          supabase.from('drivers').select('region_id').in('region_id', regionIds),
          supabase.from('service_areas').select('region_id').in('region_id', regionIds),
        ]);
        
        const stats: Record<string, RegionStats> = {};
        for (const region of parsedData) {
          stats[region.id] = {
            drivers: driversRes.data?.filter(d => d.region_id === region.id).length || 0,
            serviceAreas: areasRes.data?.filter(a => a.region_id === region.id).length || 0,
          };
        }
        setRegionStats(stats);
      }
    } catch (err) {
      console.error('Error fetching regions:', err);
      if (!isBackground) setError('Failed to load regions. Please try again.');
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

    if (!formData.geo_boundary || formData.geo_boundary.length < 3) {
      toast.error('Please draw a region boundary with at least 3 points');
      return;
    }

    setIsSaving(true);
    try {
      const { data, error } = await supabase
        .from('regions')
        .insert({
          name: formData.name,
          status: formData.status,
          distance_unit: formData.distance_unit,
          currency_code: formData.currency_code,
          timezone: formData.timezone,
          geo_boundary: formData.geo_boundary as any,
        })
        .select()
        .single();

      if (error) throw error;

      const newRegion = {
        ...data,
        geo_boundary: formData.geo_boundary,
      };

      setRegions(prev => [newRegion, ...prev]);
      setRegionStats(prev => ({ ...prev, [data.id]: { drivers: 0, serviceAreas: 0 } }));
      toast.success('Region created successfully');
      setIsAddDialogOpen(false);
      setFormData(DEFAULT_FORM_DATA);
      setActiveTab('details');
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
        .update({
          name: formData.name,
          status: formData.status,
          distance_unit: formData.distance_unit,
          currency_code: formData.currency_code,
          timezone: formData.timezone,
          geo_boundary: formData.geo_boundary as any,
        })
        .eq('id', selectedRegion.id);

      if (error) throw error;

      setRegions(prev =>
        prev.map(r => r.id === selectedRegion.id ? { 
          ...r, 
          name: formData.name, 
          status: formData.status,
          distance_unit: formData.distance_unit,
          currency_code: formData.currency_code,
          timezone: formData.timezone,
          geo_boundary: formData.geo_boundary,
        } : r)
      );
      toast.success('Region updated successfully');
      setIsEditDialogOpen(false);
      setSelectedRegion(null);
      setActiveTab('details');
    } catch (err: any) {
      console.error('Error updating region:', err);
      toast.error(err.message || 'Failed to update region');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedRegion) return;

    const stats = regionStats[selectedRegion.id];
    if (stats && (stats.drivers > 0 || stats.serviceAreas > 0)) {
      toast.error('Cannot delete region with assigned drivers or service areas');
      return;
    }

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
      toast.error(err.message || 'Failed to delete region');
    } finally {
      setIsSaving(false);
    }
  };

  const toggleStatus = async (region: Region) => {
    const newStatus = region.status === 'active' ? 'inactive' : 'active';
    
    try {
      const { error } = await supabase
        .from('regions')
        .update({ status: newStatus })
        .eq('id', region.id);

      if (error) throw error;

      setRegions(prev =>
        prev.map(r => r.id === region.id ? { ...r, status: newStatus } : r)
      );
      
      toast.success(`Region ${newStatus === 'active' ? 'activated' : 'deactivated'}`);
    } catch (err: any) {
      console.error('Error toggling region status:', err);
      toast.error(err.message || 'Failed to update region status');
    }
  };

  const openAddDialog = () => {
    setFormData(DEFAULT_FORM_DATA);
    setActiveTab('details');
    setIsAddDialogOpen(true);
  };

  const openEditDialog = (region: Region) => {
    setSelectedRegion(region);
    setFormData({
      name: region.name,
      status: region.status,
      distance_unit: region.distance_unit,
      currency_code: region.currency_code,
      timezone: region.timezone,
      geo_boundary: region.geo_boundary,
    });
    setActiveTab('details');
    setIsEditDialogOpen(true);
  };

  const openViewDialog = (region: Region) => {
    setSelectedRegion(region);
    setIsViewDialogOpen(true);
  };

  const openDeleteDialog = (region: Region) => {
    setSelectedRegion(region);
    setIsDeleteDialogOpen(true);
  };

  const getCurrencySymbol = (code: string) => {
    return CURRENCIES.find(c => c.code === code)?.symbol || code;
  };

  const totalDrivers = Object.values(regionStats).reduce((sum, s) => sum + s.drivers, 0);
  const totalServiceAreas = Object.values(regionStats).reduce((sum, s) => sum + s.serviceAreas, 0);
  const activeRegions = regions.filter(r => r.status === 'active').length;

  const RegionFormContent = ({ isNew = false, regionId }: { isNew?: boolean; regionId?: string }) => (
    <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
      <TabsList className="grid w-full grid-cols-2">
        <TabsTrigger value="details">Details</TabsTrigger>
        <TabsTrigger value="boundary">Boundary</TabsTrigger>
      </TabsList>

      <TabsContent value="details" className="space-y-4 mt-4">
        <div className="space-y-2">
          <Label htmlFor="region-name">Region Name *</Label>
          <Input
            id="region-name"
            autoFocus
            placeholder="e.g., Milton Keynes, London, Manchester"
            value={formData.name}
            onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="distance_unit">Distance Unit</Label>
            <Select
              value={formData.distance_unit}
              onValueChange={(value) => setFormData(prev => ({ ...prev, distance_unit: value }))}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="mile">Miles</SelectItem>
                <SelectItem value="km">Kilometers</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="currency">Currency</Label>
            <Select
              value={formData.currency_code}
              onValueChange={(value) => setFormData(prev => ({ ...prev, currency_code: value }))}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-60">
                {CURRENCIES.map(currency => (
                  <SelectItem key={currency.code} value={currency.code}>
                    {currency.symbol} {currency.code} - {currency.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="timezone">Timezone</Label>
            <Select
              value={formData.timezone}
              onValueChange={(value) => setFormData(prev => ({ ...prev, timezone: value }))}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-60">
                {TIMEZONES.map(tz => (
                  <SelectItem key={tz.value} value={tz.value}>
                    {tz.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
                <SelectItem value="active">
                  <span className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-green-500" />
                    Active
                  </span>
                </SelectItem>
                <SelectItem value="inactive">
                  <span className="flex items-center gap-2">
                    <XCircle className="h-4 w-4 text-gray-500" />
                    Inactive
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="bg-muted/50 rounded-lg p-4 text-sm">
          <p className="font-medium mb-2">💡 Region Settings Guide</p>
          <ul className="space-y-1 text-muted-foreground">
            <li>• <strong>Distance Unit:</strong> Used for fare calculations and display</li>
            <li>• <strong>Currency:</strong> Applied to all services in this region</li>
            <li>• <strong>Timezone:</strong> Used for scheduling and time displays</li>
            <li>• <strong>Status:</strong> Only active regions accept new rides</li>
          </ul>
        </div>

        {/* Payment Methods Notice */}
        <div className="bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-lg p-4 text-sm">
          <div className="flex items-start gap-3">
            <CreditCard className="h-5 w-5 text-blue-600 dark:text-blue-400 mt-0.5 shrink-0" />
            <div>
              <p className="font-medium text-blue-800 dark:text-blue-300 mb-1">Payment Methods</p>
              <p className="text-blue-700 dark:text-blue-400">
                Payment methods are now configured per <strong>Service Area</strong> for granular control.
                Go to <strong>Services → Configure Pricing</strong> to manage payment methods for each service area.
              </p>
            </div>
          </div>
        </div>
      </TabsContent>

      <TabsContent value="boundary" className="space-y-4 mt-4">
        <div className="bg-muted/50 rounded-lg p-4 text-sm mb-4">
          <p className="font-medium mb-2">🗺️ Drawing Instructions</p>
          <ul className="space-y-1 text-muted-foreground">
            <li>1. Click on the map to add boundary points</li>
            <li>2. Add at least 3 points to create a polygon</li>
            <li>3. Click "Finish Drawing" when done</li>
            <li>4. Drag vertices to adjust the boundary</li>
          </ul>
        </div>

        <RegionBoundaryMap
          boundary={formData.geo_boundary}
          onBoundaryChange={(boundary) => setFormData(prev => ({ ...prev, geo_boundary: boundary }))}
          isEditable={true}
          height="350px"
        />

        {formData.geo_boundary && formData.geo_boundary.length >= 3 && (
          <div className="flex items-center gap-2 text-sm text-green-600">
            <CheckCircle2 className="h-4 w-4" />
            Boundary set with {formData.geo_boundary.length} points
          </div>
        )}
      </TabsContent>
    </Tabs>
  );

  return (
    <AdminLayout 
      title="Regions" 
      description="Manage operational regions - Region controls availability"
    >
      {/* Key Principle Banner */}
      <Card className="mb-6 bg-primary/5 border-primary/20">
        <CardContent className="py-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-full bg-primary/10">
              <MapPin className="h-5 w-5 text-primary" />
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
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
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
                <p className="text-sm text-muted-foreground">Active Regions</p>
                <p className="text-2xl font-bold text-green-600">{activeRegions}</p>
              </div>
              <CheckCircle2 className="h-8 w-8 text-green-500 opacity-80" />
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
              <Map className="h-8 w-8 text-purple-500 opacity-80" />
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <MapPin className="h-5 w-5 text-primary" />
              All Regions
            </CardTitle>
            <CardDescription>
              Each region represents a licensed operating area with its own settings
            </CardDescription>
          </div>
          <Button onClick={openAddDialog}>
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
            <div className="py-12 text-center">
              <MapPin className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-lg font-medium mb-2">No regions yet</h3>
              <p className="text-muted-foreground mb-4">
                Create your first region to start accepting rides
              </p>
              <Button onClick={openAddDialog}>
                <Plus className="mr-2 h-4 w-4" />
                Create First Region
              </Button>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Region</TableHead>
                  <TableHead>Settings</TableHead>
                  <TableHead>Boundary</TableHead>
                  <TableHead>Drivers</TableHead>
                  <TableHead>Services</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {regions.map((region) => (
                  <TableRow key={region.id}>
                    <TableCell className="font-medium">{region.name}</TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-1 text-sm text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <Ruler className="h-3 w-3" />
                          {region.distance_unit === 'mile' ? 'Miles' : 'Km'}
                        </span>
                        <span className="flex items-center gap-1">
                          <DollarSign className="h-3 w-3" />
                          {getCurrencySymbol(region.currency_code)} {region.currency_code}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      {region.geo_boundary && region.geo_boundary.length >= 3 ? (
                        <Badge variant="outline" className="bg-green-500/10 text-green-600 border-green-200">
                          <CheckCircle2 className="h-3 w-3 mr-1" />
                          {region.geo_boundary.length} points
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="bg-orange-500/10 text-orange-600 border-orange-200">
                          <XCircle className="h-3 w-3 mr-1" />
                          Not set
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <span className="text-sm">{regionStats[region.id]?.drivers || 0}</span>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm">{regionStats[region.id]?.serviceAreas || 0}</span>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={region.status === 'active' ? 'default' : 'secondary'}
                        className={
                          region.status === 'active'
                            ? 'bg-green-500/10 text-green-600 hover:bg-green-500/20 cursor-pointer'
                            : 'bg-gray-500/10 text-gray-600 cursor-pointer'
                        }
                        onClick={() => toggleStatus(region)}
                      >
                        {region.status === 'active' ? (
                          <CheckCircle2 className="h-3 w-3 mr-1" />
                        ) : (
                          <XCircle className="h-3 w-3 mr-1" />
                        )}
                        {region.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
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
                          <DropdownMenuItem onClick={() => openViewDialog(region)}>
                            <Eye className="mr-2 h-4 w-4" />
                            View Details
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => openEditDialog(region)}>
                            <Pencil className="mr-2 h-4 w-4" />
                            Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => toggleStatus(region)}>
                            <Settings className="mr-2 h-4 w-4" />
                            {region.status === 'active' ? 'Deactivate' : 'Activate'}
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
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MapPin className="h-5 w-5" />
              Add New Region
            </DialogTitle>
            <DialogDescription>
              Create a new operational region with its boundary and settings
            </DialogDescription>
          </DialogHeader>
          
          <RegionFormContent isNew />

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
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="h-5 w-5" />
              Edit Region
            </DialogTitle>
            <DialogDescription>
              Update region settings and boundary
            </DialogDescription>
          </DialogHeader>
          
          <RegionFormContent regionId={selectedRegion?.id} />

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

      {/* View Region Dialog */}
      <Dialog open={isViewDialogOpen} onOpenChange={setIsViewDialogOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MapPin className="h-5 w-5" />
              {selectedRegion?.name}
            </DialogTitle>
            <DialogDescription>
              Region details and boundary
            </DialogDescription>
          </DialogHeader>
          
          {selectedRegion && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="p-4 bg-muted/50 rounded-lg">
                  <p className="text-sm text-muted-foreground">Distance Unit</p>
                  <p className="font-medium">{selectedRegion.distance_unit === 'mile' ? 'Miles' : 'Kilometers'}</p>
                </div>
                <div className="p-4 bg-muted/50 rounded-lg">
                  <p className="text-sm text-muted-foreground">Currency</p>
                  <p className="font-medium">{getCurrencySymbol(selectedRegion.currency_code)} {selectedRegion.currency_code}</p>
                </div>
                <div className="p-4 bg-muted/50 rounded-lg">
                  <p className="text-sm text-muted-foreground">Timezone</p>
                  <p className="font-medium">{TIMEZONES.find(t => t.value === selectedRegion.timezone)?.label || selectedRegion.timezone}</p>
                </div>
                <div className="p-4 bg-muted/50 rounded-lg">
                  <p className="text-sm text-muted-foreground">Status</p>
                  <Badge className={selectedRegion.status === 'active' ? 'bg-green-500' : 'bg-gray-500'}>
                    {selectedRegion.status}
                  </Badge>
                </div>
              </div>

              <div>
                <p className="text-sm text-muted-foreground mb-2">Region Boundary</p>
                <RegionBoundaryMap
                  boundary={selectedRegion.geo_boundary}
                  onBoundaryChange={() => {}}
                  isEditable={false}
                  height="300px"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
                  <p className="text-sm text-blue-600">Assigned Drivers</p>
                  <p className="text-2xl font-bold text-blue-700">{regionStats[selectedRegion.id]?.drivers || 0}</p>
                </div>
                <div className="p-4 bg-purple-50 rounded-lg border border-purple-200">
                  <p className="text-sm text-purple-600">Service Areas</p>
                  <p className="text-2xl font-bold text-purple-700">{regionStats[selectedRegion.id]?.serviceAreas || 0}</p>
                </div>
              </div>

              {/* Payment Methods Notice */}
              <div className="bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-lg p-4 text-sm">
                <div className="flex items-start gap-3">
                  <CreditCard className="h-5 w-5 text-blue-600 dark:text-blue-400 mt-0.5 shrink-0" />
                  <div>
                    <p className="font-medium text-blue-800 dark:text-blue-300 mb-1">Payment Methods</p>
                    <p className="text-blue-700 dark:text-blue-400">
                      Payment methods are configured per Service Area. Go to <strong>Services → Configure Pricing</strong> to manage.
                    </p>
                  </div>
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
              if (selectedRegion) openEditDialog(selectedRegion);
            }}>
              <Pencil className="mr-2 h-4 w-4" />
              Edit Region
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
              {selectedRegion && regionStats[selectedRegion.id] && (
                (regionStats[selectedRegion.id].drivers > 0 || regionStats[selectedRegion.id].serviceAreas > 0) ? (
                  <span className="block mt-2 text-destructive font-medium">
                    ⚠️ This region has {regionStats[selectedRegion.id].drivers} drivers and {regionStats[selectedRegion.id].serviceAreas} service areas assigned. Remove them first.
                  </span>
                ) : null
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-red-600 hover:bg-red-700"
              disabled={isSaving || (selectedRegion && regionStats[selectedRegion.id] && 
                (regionStats[selectedRegion.id].drivers > 0 || regionStats[selectedRegion.id].serviceAreas > 0))}
            >
              {isSaving ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AdminLayout>
  );
}
