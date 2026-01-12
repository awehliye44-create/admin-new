import { useEffect, useState } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Checkbox } from '@/components/ui/checkbox';
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
import { supabase } from '@/integrations/supabase/client';
import { 
  Car, 
  Loader2, 
  Star, 
  Search, 
  MoreHorizontal,
  CheckCircle,
  XCircle,
  Eye,
  Clock,
  Users,
  UserCheck,
  UserX,
  Phone,
  Mail,
  MapPin,
  UserPlus,
  Pencil,
  Map,
  Save
} from 'lucide-react';
import { toast } from 'sonner';

interface Driver {
  id: string;
  driver_code: string | null;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  is_online: boolean;
  approval_status: string;
  rating: number | null;
  total_trips: number | null;
  profile_photo_url: string | null;
  created_at: string;
  region_id: string;
}

interface Vehicle {
  id: string;
  make: string;
  model: string;
  year: number;
  color: string;
  license_plate: string;
  is_primary: boolean;
}

interface Region {
  id: string;
  name: string;
}

interface ServiceArea {
  id: string;
  name: string;
  region_id: string;
  is_active: boolean;
}

interface DriverServiceArea {
  id: string;
  driver_id: string;
  service_area_id: string;
}

export default function Drivers() {
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [vehicles, setVehicles] = useState<Record<string, Vehicle[]>>({});
  const [regions, setRegions] = useState<Record<string, Region>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [selectedDriver, setSelectedDriver] = useState<Driver | null>(null);
  const [isDetailsOpen, setIsDetailsOpen] = useState(false);
  const [isUpdating, setIsUpdating] = useState<string | null>(null);
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [isAdding, setIsAdding] = useState(false);
  const [regionsList, setRegionsList] = useState<Region[]>([]);
  const [newDriver, setNewDriver] = useState({
    first_name: '',
    last_name: '',
    email: '',
    phone: '',
    region_id: '',
  });

  // Edit driver state
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [editDriver, setEditDriver] = useState<Driver | null>(null);
  const [isSavingEdit, setIsSavingEdit] = useState(false);

  // Service areas state
  const [isServiceAreasDialogOpen, setIsServiceAreasDialogOpen] = useState(false);
  const [serviceAreas, setServiceAreas] = useState<ServiceArea[]>([]);
  const [driverServiceAreas, setDriverServiceAreas] = useState<DriverServiceArea[]>([]);
  const [selectedServiceAreas, setSelectedServiceAreas] = useState<string[]>([]);
  const [isSavingServiceAreas, setIsSavingServiceAreas] = useState(false);

  const fetchDrivers = async () => {
    try {
      setIsLoading(true);
      const { data, error } = await supabase
        .from('drivers')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) throw error;
      setDrivers(data || []);

      // Fetch regions
      const { data: regionsData } = await supabase
        .from('regions')
        .select('id, name');
      
      if (regionsData) {
        setRegionsList(regionsData);
        const regionsMap: Record<string, Region> = {};
        regionsData.forEach(r => { regionsMap[r.id] = r; });
        setRegions(regionsMap);
      }

      // Fetch service areas
      const { data: serviceAreasData } = await supabase
        .from('service_areas')
        .select('*')
        .eq('is_active', true);
      
      if (serviceAreasData) {
        setServiceAreas(serviceAreasData);
      }

      // Fetch vehicles for all drivers
      if (data && data.length > 0) {
        const driverIds = data.map(d => d.id);
        const { data: vehiclesData } = await supabase
          .from('vehicles')
          .select('*')
          .in('driver_id', driverIds);
        
        if (vehiclesData) {
          const vehiclesMap: Record<string, Vehicle[]> = {};
          vehiclesData.forEach(v => {
            if (!vehiclesMap[v.driver_id]) vehiclesMap[v.driver_id] = [];
            vehiclesMap[v.driver_id].push(v);
          });
          setVehicles(vehiclesMap);
        }
      }
    } catch (err) {
      console.error('Error fetching drivers:', err);
      setError('Failed to load drivers. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchDrivers();
  }, []);

  const updateDriverStatus = async (driverId: string, newStatus: string) => {
    setIsUpdating(driverId);
    try {
      const { error } = await supabase
        .from('drivers')
        .update({ approval_status: newStatus })
        .eq('id', driverId);

      if (error) throw error;

      setDrivers(prev => 
        prev.map(d => d.id === driverId ? { ...d, approval_status: newStatus } : d)
      );
      
      toast.success(`Driver ${newStatus === 'approved' ? 'approved' : newStatus === 'rejected' ? 'rejected' : 'set to pending'} successfully`);
      
      if (selectedDriver?.id === driverId) {
        setSelectedDriver(prev => prev ? { ...prev, approval_status: newStatus } : null);
      }
    } catch (err) {
      console.error('Error updating driver status:', err);
      toast.error('Failed to update driver status');
    } finally {
      setIsUpdating(null);
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'approved':
        return 'bg-green-500/10 text-green-600 hover:bg-green-500/20';
      case 'pending':
        return 'bg-yellow-500/10 text-yellow-600 hover:bg-yellow-500/20';
      case 'rejected':
        return 'bg-red-500/10 text-red-600 hover:bg-red-500/20';
      default:
        return '';
    }
  };

  const filteredDrivers = drivers.filter(driver => {
    const matchesSearch = 
      driver.first_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      driver.last_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      driver.email.toLowerCase().includes(searchQuery.toLowerCase()) ||
      driver.phone.includes(searchQuery);
    
    const matchesStatus = statusFilter === 'all' || driver.approval_status === statusFilter;
    
    return matchesSearch && matchesStatus;
  });

  const statusCounts = {
    all: drivers.length,
    pending: drivers.filter(d => d.approval_status === 'pending').length,
    approved: drivers.filter(d => d.approval_status === 'approved').length,
    rejected: drivers.filter(d => d.approval_status === 'rejected').length,
  };

  const openDriverDetails = (driver: Driver) => {
    setSelectedDriver(driver);
    setIsDetailsOpen(true);
  };

  const resetNewDriverForm = () => {
    setNewDriver({
      first_name: '',
      last_name: '',
      email: '',
      phone: '',
      region_id: '',
    });
  };

  const handleAddDriver = async () => {
    if (!newDriver.first_name || !newDriver.last_name || !newDriver.email || !newDriver.phone || !newDriver.region_id) {
      toast.error('Please fill in all fields');
      return;
    }

    setIsAdding(true);
    try {
      const { data, error } = await supabase
        .from('drivers')
        .insert({
          first_name: newDriver.first_name,
          last_name: newDriver.last_name,
          email: newDriver.email,
          phone: newDriver.phone,
          region_id: newDriver.region_id,
          user_id: crypto.randomUUID(),
          approval_status: 'approved',
        })
        .select()
        .single();

      if (error) throw error;

      setDrivers(prev => [data, ...prev]);
      toast.success('Driver added successfully');
      setIsAddDialogOpen(false);
      resetNewDriverForm();
    } catch (err: any) {
      console.error('Error adding driver:', err);
      toast.error(err.message || 'Failed to add driver');
    } finally {
      setIsAdding(false);
    }
  };

  // Edit driver functions
  const openEditDialog = (driver: Driver) => {
    setEditDriver({ ...driver });
    setIsEditDialogOpen(true);
  };

  const handleSaveEdit = async () => {
    if (!editDriver) return;

    if (!editDriver.first_name || !editDriver.last_name || !editDriver.email || !editDriver.phone) {
      toast.error('Please fill in all required fields');
      return;
    }

    setIsSavingEdit(true);
    try {
      const { error } = await supabase
        .from('drivers')
        .update({
          first_name: editDriver.first_name,
          last_name: editDriver.last_name,
          email: editDriver.email,
          phone: editDriver.phone,
          region_id: editDriver.region_id,
        })
        .eq('id', editDriver.id);

      if (error) throw error;

      setDrivers(prev => 
        prev.map(d => d.id === editDriver.id ? { ...d, ...editDriver } : d)
      );
      
      if (selectedDriver?.id === editDriver.id) {
        setSelectedDriver(editDriver);
      }
      
      toast.success('Driver updated successfully');
      setIsEditDialogOpen(false);
      setEditDriver(null);
    } catch (err: any) {
      console.error('Error updating driver:', err);
      toast.error(err.message || 'Failed to update driver');
    } finally {
      setIsSavingEdit(false);
    }
  };

  // Service areas functions
  const openServiceAreasDialog = async (driver: Driver) => {
    setSelectedDriver(driver);
    setIsSavingServiceAreas(true);
    
    try {
      // Fetch current service areas for this driver
      const { data, error } = await supabase
        .from('driver_service_areas')
        .select('*')
        .eq('driver_id', driver.id);

      if (error) throw error;

      setDriverServiceAreas(data || []);
      setSelectedServiceAreas((data || []).map(d => d.service_area_id));
    } catch (err) {
      console.error('Error fetching driver service areas:', err);
      toast.error('Failed to load service areas');
    } finally {
      setIsSavingServiceAreas(false);
      setIsServiceAreasDialogOpen(true);
    }
  };

  const toggleServiceArea = (serviceAreaId: string) => {
    setSelectedServiceAreas(prev => 
      prev.includes(serviceAreaId) 
        ? prev.filter(id => id !== serviceAreaId)
        : [...prev, serviceAreaId]
    );
  };

  const handleSaveServiceAreas = async () => {
    if (!selectedDriver) return;

    setIsSavingServiceAreas(true);
    try {
      // Get current assignments
      const currentIds = driverServiceAreas.map(d => d.service_area_id);
      const toAdd = selectedServiceAreas.filter(id => !currentIds.includes(id));
      const toRemove = currentIds.filter(id => !selectedServiceAreas.includes(id));

      // Remove unselected
      if (toRemove.length > 0) {
        const { error: deleteError } = await supabase
          .from('driver_service_areas')
          .delete()
          .eq('driver_id', selectedDriver.id)
          .in('service_area_id', toRemove);

        if (deleteError) throw deleteError;
      }

      // Add new selections
      if (toAdd.length > 0) {
        const newAssignments = toAdd.map(service_area_id => ({
          driver_id: selectedDriver.id,
          service_area_id,
        }));

        const { error: insertError } = await supabase
          .from('driver_service_areas')
          .insert(newAssignments);

        if (insertError) throw insertError;
      }

      toast.success('Service areas updated successfully');
      setIsServiceAreasDialogOpen(false);
    } catch (err: any) {
      console.error('Error saving service areas:', err);
      toast.error(err.message || 'Failed to update service areas');
    } finally {
      setIsSavingServiceAreas(false);
    }
  };

  // Get service areas for the selected driver's region
  const getFilteredServiceAreas = () => {
    if (!selectedDriver) return serviceAreas;
    return serviceAreas.filter(sa => sa.region_id === selectedDriver.region_id);
  };

  return (
    <AdminLayout 
      title="Driver Profiles" 
      description="Manage your fleet drivers"
    >
      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Total Drivers</p>
                <p className="text-2xl font-bold">{statusCounts.all}</p>
              </div>
              <Users className="h-8 w-8 text-primary opacity-80" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-yellow-500/30 bg-yellow-500/5">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Pending Approval</p>
                <p className="text-2xl font-bold text-yellow-600">{statusCounts.pending}</p>
              </div>
              <Clock className="h-8 w-8 text-yellow-500" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-green-500/30 bg-green-500/5">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Approved</p>
                <p className="text-2xl font-bold text-green-600">{statusCounts.approved}</p>
              </div>
              <UserCheck className="h-8 w-8 text-green-500" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-red-500/30 bg-red-500/5">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Rejected</p>
                <p className="text-2xl font-bold text-red-600">{statusCounts.rejected}</p>
              </div>
              <UserX className="h-8 w-8 text-red-500" />
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <CardTitle className="flex items-center gap-2">
            <Car className="h-5 w-5 text-primary" />
            All Drivers
          </CardTitle>
          <div className="flex flex-col gap-2 md:flex-row md:items-center">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search drivers..."
                className="pl-9 w-full md:w-[250px]"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
            <Button onClick={() => setIsAddDialogOpen(true)}>
              <UserPlus className="mr-2 h-4 w-4" />
              Add Driver
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {/* Status Tabs */}
          <Tabs value={statusFilter} onValueChange={setStatusFilter} className="mb-6">
            <TabsList>
              <TabsTrigger value="all" className="gap-2">
                All <Badge variant="secondary" className="ml-1">{statusCounts.all}</Badge>
              </TabsTrigger>
              <TabsTrigger value="pending" className="gap-2">
                Pending <Badge variant="secondary" className="ml-1 bg-yellow-500/10 text-yellow-600">{statusCounts.pending}</Badge>
              </TabsTrigger>
              <TabsTrigger value="approved" className="gap-2">
                Approved <Badge variant="secondary" className="ml-1 bg-green-500/10 text-green-600">{statusCounts.approved}</Badge>
              </TabsTrigger>
              <TabsTrigger value="rejected" className="gap-2">
                Rejected <Badge variant="secondary" className="ml-1 bg-red-500/10 text-red-600">{statusCounts.rejected}</Badge>
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
          ) : error ? (
            <div className="py-8 text-center text-destructive">{error}</div>
          ) : filteredDrivers.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground">
              {searchQuery ? 'No drivers found matching your search.' : `No ${statusFilter === 'all' ? '' : statusFilter} drivers found.`}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Driver ID</TableHead>
                  <TableHead>Driver</TableHead>
                  <TableHead>Contact</TableHead>
                  <TableHead>Region</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Online</TableHead>
                  <TableHead>Rating</TableHead>
                  <TableHead>Trips</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredDrivers.map((driver) => (
                  <TableRow key={driver.id}>
                    <TableCell>
                      <div className="font-mono text-sm font-medium text-primary">
                        {driver.driver_code || driver.id.slice(0, 8)}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <Avatar className="h-9 w-9">
                          <AvatarImage src={driver.profile_photo_url || ''} />
                          <AvatarFallback>
                            {driver.first_name[0]}{driver.last_name[0]}
                          </AvatarFallback>
                        </Avatar>
                        <div>
                          <p className="font-medium">{driver.first_name} {driver.last_name}</p>
                          <p className="text-xs text-muted-foreground">
                            Joined {new Date(driver.created_at).toLocaleDateString()}
                          </p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div>
                        <p className="text-sm">{driver.email}</p>
                        <p className="text-sm text-muted-foreground">{driver.phone}</p>
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm">
                        {regions[driver.region_id]?.name || 'Unknown'}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="secondary"
                        className={getStatusColor(driver.approval_status)}
                      >
                        {driver.approval_status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={driver.is_online ? 'default' : 'secondary'}
                        className={
                          driver.is_online
                            ? 'bg-green-500/10 text-green-600'
                            : 'bg-gray-500/10 text-gray-600'
                        }
                      >
                        {driver.is_online ? 'Online' : 'Offline'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Star className="h-4 w-4 text-yellow-500 fill-yellow-500" />
                        <span>{driver.rating?.toFixed(1) || 'N/A'}</span>
                      </div>
                    </TableCell>
                    <TableCell>{driver.total_trips || 0}</TableCell>
                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" disabled={isUpdating === driver.id}>
                            {isUpdating === driver.id ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <MoreHorizontal className="h-4 w-4" />
                            )}
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => openDriverDetails(driver)}>
                            <Eye className="mr-2 h-4 w-4" />
                            View Details
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => openEditDialog(driver)}>
                            <Pencil className="mr-2 h-4 w-4" />
                            Edit Profile
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => openServiceAreasDialog(driver)}>
                            <Map className="mr-2 h-4 w-4" />
                            Assign Service Areas
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          {driver.approval_status !== 'approved' && (
                            <DropdownMenuItem 
                              onClick={() => updateDriverStatus(driver.id, 'approved')}
                              className="text-green-600"
                            >
                              <CheckCircle className="mr-2 h-4 w-4" />
                              Approve Driver
                            </DropdownMenuItem>
                          )}
                          {driver.approval_status !== 'rejected' && (
                            <DropdownMenuItem 
                              onClick={() => updateDriverStatus(driver.id, 'rejected')}
                              className="text-red-600"
                            >
                              <XCircle className="mr-2 h-4 w-4" />
                              Reject Driver
                            </DropdownMenuItem>
                          )}
                          {driver.approval_status !== 'pending' && (
                            <DropdownMenuItem 
                              onClick={() => updateDriverStatus(driver.id, 'pending')}
                              className="text-yellow-600"
                            >
                              <Clock className="mr-2 h-4 w-4" />
                              Set as Pending
                            </DropdownMenuItem>
                          )}
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

      {/* Driver Details Dialog */}
      <Dialog open={isDetailsOpen} onOpenChange={setIsDetailsOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Driver Details</DialogTitle>
            <DialogDescription>
              View and manage driver information
            </DialogDescription>
          </DialogHeader>
          
          {selectedDriver && (
            <div className="space-y-6">
              {/* Profile Section */}
              <div className="flex items-start gap-4">
                <Avatar className="h-20 w-20">
                  <AvatarImage src={selectedDriver.profile_photo_url || ''} />
                  <AvatarFallback className="text-2xl">
                    {selectedDriver.first_name[0]}{selectedDriver.last_name[0]}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1">
                  <h3 className="text-xl font-semibold">
                    {selectedDriver.first_name} {selectedDriver.last_name}
                  </h3>
                  <div className="flex items-center gap-2 mt-1">
                    <Badge className={getStatusColor(selectedDriver.approval_status)}>
                      {selectedDriver.approval_status}
                    </Badge>
                    <Badge
                      className={
                        selectedDriver.is_online
                          ? 'bg-green-500/10 text-green-600'
                          : 'bg-gray-500/10 text-gray-600'
                      }
                    >
                      {selectedDriver.is_online ? 'Online' : 'Offline'}
                    </Badge>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Star className="h-5 w-5 text-yellow-500 fill-yellow-500" />
                  <span className="text-lg font-medium">
                    {selectedDriver.rating?.toFixed(1) || 'N/A'}
                  </span>
                </div>
              </div>

              {/* Contact Info */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="flex items-center gap-3 p-3 bg-muted/50 rounded-lg">
                  <Mail className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <p className="text-xs text-muted-foreground">Email</p>
                    <p className="text-sm font-medium">{selectedDriver.email}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3 p-3 bg-muted/50 rounded-lg">
                  <Phone className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <p className="text-xs text-muted-foreground">Phone</p>
                    <p className="text-sm font-medium">{selectedDriver.phone}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3 p-3 bg-muted/50 rounded-lg">
                  <MapPin className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <p className="text-xs text-muted-foreground">Region</p>
                    <p className="text-sm font-medium">
                      {regions[selectedDriver.region_id]?.name || 'Unknown'}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3 p-3 bg-muted/50 rounded-lg">
                  <Car className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <p className="text-xs text-muted-foreground">Total Trips</p>
                    <p className="text-sm font-medium">{selectedDriver.total_trips || 0}</p>
                  </div>
                </div>
              </div>

              {/* Vehicles */}
              {vehicles[selectedDriver.id] && vehicles[selectedDriver.id].length > 0 && (
                <div>
                  <h4 className="font-medium mb-3">Vehicles</h4>
                  <div className="space-y-2">
                    {vehicles[selectedDriver.id].map((vehicle) => (
                      <div 
                        key={vehicle.id} 
                        className="flex items-center justify-between p-3 bg-muted/50 rounded-lg"
                      >
                        <div className="flex items-center gap-3">
                          <Car className="h-5 w-5 text-muted-foreground" />
                          <div>
                            <p className="font-medium">
                              {vehicle.year} {vehicle.make} {vehicle.model}
                            </p>
                            <p className="text-sm text-muted-foreground">
                              {vehicle.color} • {vehicle.license_plate}
                            </p>
                          </div>
                        </div>
                        {vehicle.is_primary && (
                          <Badge variant="outline">Primary</Badge>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Actions */}
              <div className="flex gap-2 pt-4 border-t flex-wrap">
                <Button 
                  variant="outline"
                  onClick={() => {
                    setIsDetailsOpen(false);
                    openEditDialog(selectedDriver);
                  }}
                >
                  <Pencil className="mr-2 h-4 w-4" />
                  Edit Profile
                </Button>
                <Button 
                  variant="outline"
                  onClick={() => {
                    setIsDetailsOpen(false);
                    openServiceAreasDialog(selectedDriver);
                  }}
                >
                  <Map className="mr-2 h-4 w-4" />
                  Service Areas
                </Button>
                {selectedDriver.approval_status !== 'approved' && (
                  <Button 
                    onClick={() => updateDriverStatus(selectedDriver.id, 'approved')}
                    disabled={isUpdating === selectedDriver.id}
                    className="bg-green-600 hover:bg-green-700"
                  >
                    {isUpdating === selectedDriver.id ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <CheckCircle className="mr-2 h-4 w-4" />
                    )}
                    Approve
                  </Button>
                )}
                {selectedDriver.approval_status !== 'rejected' && (
                  <Button 
                    variant="destructive"
                    onClick={() => updateDriverStatus(selectedDriver.id, 'rejected')}
                    disabled={isUpdating === selectedDriver.id}
                  >
                    {isUpdating === selectedDriver.id ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <XCircle className="mr-2 h-4 w-4" />
                    )}
                    Reject
                  </Button>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Edit Driver Dialog */}
      <Dialog open={isEditDialogOpen} onOpenChange={(open) => {
        setIsEditDialogOpen(open);
        if (!open) setEditDriver(null);
      }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="h-5 w-5" />
              Edit Driver Profile
            </DialogTitle>
            <DialogDescription>
              Update driver information
            </DialogDescription>
          </DialogHeader>
          
          {editDriver && (
            <div className="space-y-4 py-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="edit_first_name">First Name</Label>
                  <Input
                    id="edit_first_name"
                    value={editDriver.first_name}
                    onChange={(e) => setEditDriver(prev => prev ? { ...prev, first_name: e.target.value } : null)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit_last_name">Last Name</Label>
                  <Input
                    id="edit_last_name"
                    value={editDriver.last_name}
                    onChange={(e) => setEditDriver(prev => prev ? { ...prev, last_name: e.target.value } : null)}
                  />
                </div>
              </div>
              
              <div className="space-y-2">
                <Label htmlFor="edit_email">Email</Label>
                <Input
                  id="edit_email"
                  type="email"
                  value={editDriver.email}
                  onChange={(e) => setEditDriver(prev => prev ? { ...prev, email: e.target.value } : null)}
                />
              </div>
              
              <div className="space-y-2">
                <Label htmlFor="edit_phone">Phone</Label>
                <Input
                  id="edit_phone"
                  type="tel"
                  value={editDriver.phone}
                  onChange={(e) => setEditDriver(prev => prev ? { ...prev, phone: e.target.value } : null)}
                />
              </div>
              
              <div className="space-y-2">
                <Label htmlFor="edit_region">Region</Label>
                <Select
                  value={editDriver.region_id}
                  onValueChange={(value) => setEditDriver(prev => prev ? { ...prev, region_id: value } : null)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select a region" />
                  </SelectTrigger>
                  <SelectContent>
                    {regionsList.map((region) => (
                      <SelectItem key={region.id} value={region.id}>
                        {region.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="edit_status">Approval Status</Label>
                <Select
                  value={editDriver.approval_status}
                  onValueChange={(value) => setEditDriver(prev => prev ? { ...prev, approval_status: value } : null)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="pending">Pending</SelectItem>
                    <SelectItem value="approved">Approved</SelectItem>
                    <SelectItem value="rejected">Rejected</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsEditDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSaveEdit} disabled={isSavingEdit}>
              {isSavingEdit ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Save className="mr-2 h-4 w-4" />
                  Save Changes
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Assign Service Areas Dialog */}
      <Dialog open={isServiceAreasDialogOpen} onOpenChange={setIsServiceAreasDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Map className="h-5 w-5" />
              Assign Service Areas
            </DialogTitle>
            <DialogDescription>
              {selectedDriver && (
                <>Select service areas for {selectedDriver.first_name} {selectedDriver.last_name}</>
              )}
            </DialogDescription>
          </DialogHeader>
          
          <div className="py-4">
            {getFilteredServiceAreas().length === 0 ? (
              <div className="text-center text-muted-foreground py-8">
                No service areas available for this region
              </div>
            ) : (
              <div className="space-y-3 max-h-[300px] overflow-y-auto">
                {getFilteredServiceAreas().map((area) => (
                  <div
                    key={area.id}
                    className="flex items-center space-x-3 p-3 border rounded-lg hover:bg-muted/50 cursor-pointer"
                    onClick={() => toggleServiceArea(area.id)}
                  >
                    <Checkbox
                      id={area.id}
                      checked={selectedServiceAreas.includes(area.id)}
                      onCheckedChange={() => toggleServiceArea(area.id)}
                    />
                    <div className="flex-1">
                      <label
                        htmlFor={area.id}
                        className="text-sm font-medium cursor-pointer"
                      >
                        {area.name}
                      </label>
                    </div>
                    {selectedServiceAreas.includes(area.id) && (
                      <CheckCircle className="h-4 w-4 text-green-500" />
                    )}
                  </div>
                ))}
              </div>
            )}
            
            <div className="mt-4 p-3 bg-muted/50 rounded-lg">
              <p className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">{selectedServiceAreas.length}</span> service area(s) selected
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsServiceAreasDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSaveServiceAreas} disabled={isSavingServiceAreas}>
              {isSavingServiceAreas ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Save className="mr-2 h-4 w-4" />
                  Save Service Areas
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Driver Dialog */}
      <Dialog open={isAddDialogOpen} onOpenChange={(open) => {
        setIsAddDialogOpen(open);
        if (!open) resetNewDriverForm();
      }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <UserPlus className="h-5 w-5" />
              Add New Driver
            </DialogTitle>
            <DialogDescription>
              Create a new driver profile. Admin-created drivers are auto-approved.
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="first_name">First Name</Label>
                <Input
                  id="first_name"
                  placeholder="John"
                  value={newDriver.first_name}
                  onChange={(e) => setNewDriver(prev => ({ ...prev, first_name: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="last_name">Last Name</Label>
                <Input
                  id="last_name"
                  placeholder="Doe"
                  value={newDriver.last_name}
                  onChange={(e) => setNewDriver(prev => ({ ...prev, last_name: e.target.value }))}
                />
              </div>
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                placeholder="john.doe@example.com"
                value={newDriver.email}
                onChange={(e) => setNewDriver(prev => ({ ...prev, email: e.target.value }))}
              />
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="phone">Phone</Label>
              <Input
                id="phone"
                type="tel"
                placeholder="+44 123 456 7890"
                value={newDriver.phone}
                onChange={(e) => setNewDriver(prev => ({ ...prev, phone: e.target.value }))}
              />
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="region">Region</Label>
              <Select
                value={newDriver.region_id}
                onValueChange={(value) => setNewDriver(prev => ({ ...prev, region_id: value }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a region" />
                </SelectTrigger>
                <SelectContent>
                  {regionsList.map((region) => (
                    <SelectItem key={region.id} value={region.id}>
                      {region.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsAddDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleAddDriver} disabled={isAdding}>
              {isAdding ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Adding...
                </>
              ) : (
                <>
                  <UserPlus className="mr-2 h-4 w-4" />
                  Add Driver
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
}
