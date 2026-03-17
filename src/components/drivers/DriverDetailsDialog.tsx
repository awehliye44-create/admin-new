import { useState, useEffect } from 'react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { Progress } from '@/components/ui/progress';
import { 
  Car, Star, Phone, Mail, MapPin, CheckCircle, XCircle, 
  Loader2, Pencil, Map, AlertTriangle, PawPrint, Users,
  Truck, Shield, CreditCard, ExternalLink, Send, Crown, Target,
  FileText, Clock, AlertOctagon, FileWarning
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
  is_pet_friendly?: boolean;
  stripe_account_id?: string | null;
  payouts_enabled?: boolean;
  charges_enabled?: boolean;
  onboarding_complete?: boolean;
}

interface Vehicle {
  id: string;
  make: string;
  model: string;
  year: number;
  color: string;
  license_plate: string;
  is_primary: boolean;
  approval_status: string;
  rejection_reason: string | null;
  capacity: number;
  vehicle_type_id: string | null;
  driver_id: string;
}

interface VehicleType {
  id: string;
  name: string;
  capacity: number;
  categories: string[];
  features: string[];
  is_default: boolean;
  driver_controllable: boolean;
}

interface DriverVehicleCategory {
  id: string;
  driver_id: string;
  vehicle_type_id: string;
  is_enabled: boolean;
}

interface Region {
  id: string;
  name: string;
}

interface DriverDetailsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  driver: Driver | null;
  vehicles: Vehicle[];
  regions: Record<string, Region>;
  onDriverUpdate: (driver: Driver) => void;
  onVehicleUpdate: (vehicle: Vehicle) => void;
  onEditProfile: (driver: Driver) => void;
  onManageServiceAreas: (driver: Driver) => void;
}

export function DriverDetailsDialog({
  open,
  onOpenChange,
  driver,
  vehicles,
  regions,
  onDriverUpdate,
  onVehicleUpdate,
  onEditProfile,
  onManageServiceAreas,
}: DriverDetailsDialogProps) {
  const [activeTab, setActiveTab] = useState('overview');
  const [isUpdating, setIsUpdating] = useState(false);
  const [vehicleTypes, setVehicleTypes] = useState<VehicleType[]>([]);
  const [driverCategories, setDriverCategories] = useState<DriverVehicleCategory[]>([]);
  const [isPetFriendly, setIsPetFriendly] = useState(driver?.is_pet_friendly ?? false);
  
  // Vehicle rejection dialog state
  const [rejectVehicleId, setRejectVehicleId] = useState<string | null>(null);
  const [rejectionReason, setRejectionReason] = useState('');
  const [isRejecting, setIsRejecting] = useState(false);
  const [isSendingOnboardLink, setIsSendingOnboardLink] = useState(false);
  const [showManageCategories, setShowManageCategories] = useState(false);

  // Commission management state
  const [tierCategories, setTierCategories] = useState<any[]>([]);
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>('');
  const [commissionOverride] = useState<string>('');
  const [isSavingCommission, setIsSavingCommission] = useState(false);

  // Document compliance state
  const [documentCompliance, setDocumentCompliance] = useState<{
    requiredTypes: { slug: string; name: string; has_expiry: boolean }[];
    driverDocs: { document_type: string; status: string; expiry_date: string | null }[];
  }>({ requiredTypes: [], driverDocs: [] });
  const [isLoadingDocs, setIsLoadingDocs] = useState(false);

  useEffect(() => {
    if (open && driver) {
      setIsPetFriendly(driver.is_pet_friendly ?? false);
      fetchVehicleTypes();
      fetchDriverCategories();
      fetchTierCategories();
      fetchDriverCommissionData();
      fetchDocumentCompliance();
    }
  }, [open, driver?.id]);

  const fetchDocumentCompliance = async () => {
    if (!driver) return;
    setIsLoadingDocs(true);
    try {
      const [typesRes, docsRes] = await Promise.all([
        supabase
          .from('document_types')
          .select('slug, name, has_expiry')
          .eq('is_required', true)
          .eq('is_active', true)
          .order('display_order'),
        supabase
          .from('documents')
          .select('document_type, status, expiry_date')
          .eq('driver_id', driver.id),
      ]);
      setDocumentCompliance({
        requiredTypes: (typesRes.data || []) as any,
        driverDocs: (docsRes.data || []) as any,
      });
    } catch (err) {
      console.error('Error fetching document compliance:', err);
    } finally {
      setIsLoadingDocs(false);
    }
  };

  const getDocComplianceItems = () => {
    const { requiredTypes, driverDocs } = documentCompliance;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    return requiredTypes.map((dt) => {
      const doc = driverDocs.find((d) => d.document_type === dt.slug);
      if (!doc) return { name: dt.name, slug: dt.slug, status: 'missing' as const, daysLeft: null };

      if (doc.status === 'rejected') return { name: dt.name, slug: dt.slug, status: 'rejected' as const, daysLeft: null };
      if (doc.status !== 'approved') return { name: dt.name, slug: dt.slug, status: 'pending' as const, daysLeft: null };

      // Approved — check expiry
      if (doc.expiry_date) {
        const expiry = new Date(doc.expiry_date);
        expiry.setHours(0, 0, 0, 0);
        const daysLeft = Math.ceil((expiry.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
        if (daysLeft < 0) return { name: dt.name, slug: dt.slug, status: 'expired' as const, daysLeft };
        if (daysLeft <= 30) return { name: dt.name, slug: dt.slug, status: 'expiring_soon' as const, daysLeft };
      }

      return { name: dt.name, slug: dt.slug, status: 'valid' as const, daysLeft: null };
    });
  };

  const canApproveDriver = () => {
    const items = getDocComplianceItems();
    if (items.length === 0) return true; // No required docs configured
    return items.every((i) => i.status === 'valid' || i.status === 'expiring_soon');
  };

  const fetchTierCategories = async () => {
    const { data } = await supabase
      .from('driver_categories')
      .select('*')
      .eq('is_active', true)
      .order('level_order');
    if (data) setTierCategories(data);
  };

  const fetchDriverCommissionData = async () => {
    if (!driver) return;
    const { data } = await supabase
      .from('drivers')
      .select('category_id')
      .eq('id', driver.id)
      .single();
    if (data) {
      setSelectedCategoryId((data as any).category_id || '');
    }
  };

  const saveCommissionSettings = async () => {
    if (!driver) return;
    setIsSavingCommission(true);
    try {
      const updateData: Record<string, any> = {
        category_id: selectedCategoryId || null,
      };
      const { error } = await supabase
        .from('drivers')
        .update(updateData)
        .eq('id', driver.id);
      if (error) throw error;
      toast.success('Commission settings saved');
    } catch (err) {
      console.error('Error saving commission:', err);
      toast.error('Failed to save commission settings');
    } finally {
      setIsSavingCommission(false);
    }
  };

  const fetchVehicleTypes = async () => {
    const { data } = await supabase
      .from('vehicle_types')
      .select('*')
      .eq('is_active', true)
      .order('display_order');
    
    if (data) setVehicleTypes(data);
  };

  const fetchDriverCategories = async () => {
    if (!driver) return;
    
    const { data } = await supabase
      .from('driver_vehicle_categories')
      .select('*')
      .eq('driver_id', driver.id);
    
    if (data) setDriverCategories(data);
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'approved':
        return 'bg-green-500/10 text-green-600 border-green-500/30';
      case 'pending':
        return 'bg-yellow-500/10 text-yellow-600 border-yellow-500/30';
      case 'rejected':
        return 'bg-red-500/10 text-red-600 border-red-500/30';
      default:
        return 'bg-muted text-muted-foreground';
    }
  };

  const updateDriverStatus = async (newStatus: string) => {
    if (!driver) return;
    
    setIsUpdating(true);
    try {
      const { error } = await supabase
        .from('drivers')
        .update({ approval_status: newStatus })
        .eq('id', driver.id);

      if (error) throw error;
      
      onDriverUpdate({ ...driver, approval_status: newStatus });
      toast.success(`Driver ${newStatus === 'approved' ? 'approved' : newStatus === 'rejected' ? 'rejected' : 'set to pending'} successfully`);
    } catch (err) {
      console.error('Error updating driver:', err);
      toast.error('Failed to update driver status');
    } finally {
      setIsUpdating(false);
    }
  };

  const updatePetFriendly = async (value: boolean) => {
    if (!driver) return;
    
    setIsPetFriendly(value);
    try {
      const { error } = await supabase
        .from('drivers')
        .update({ is_pet_friendly: value })
        .eq('id', driver.id);

      if (error) throw error;
      
      onDriverUpdate({ ...driver, is_pet_friendly: value });
      toast.success(`Pet-friendly ${value ? 'enabled' : 'disabled'}`);
    } catch (err) {
      console.error('Error updating driver:', err);
      toast.error('Failed to update driver');
      setIsPetFriendly(!value);
    }
  };

  const approveVehicle = async (vehicleId: string) => {
    setIsUpdating(true);
    try {
      const { error } = await supabase
        .from('vehicles')
        .update({ approval_status: 'approved', rejection_reason: null })
        .eq('id', vehicleId);

      if (error) throw error;
      
      const vehicle = vehicles.find(v => v.id === vehicleId);
      if (vehicle) {
        onVehicleUpdate({ ...vehicle, approval_status: 'approved', rejection_reason: null });
      }
      toast.success('Vehicle approved successfully');
    } catch (err) {
      console.error('Error approving vehicle:', err);
      toast.error('Failed to approve vehicle');
    } finally {
      setIsUpdating(false);
    }
  };

  const rejectVehicle = async () => {
    if (!rejectVehicleId || !rejectionReason.trim()) {
      toast.error('Please provide a rejection reason');
      return;
    }

    setIsRejecting(true);
    try {
      const { error } = await supabase
        .from('vehicles')
        .update({ 
          approval_status: 'rejected', 
          rejection_reason: rejectionReason.trim() 
        })
        .eq('id', rejectVehicleId);

      if (error) throw error;
      
      const vehicle = vehicles.find(v => v.id === rejectVehicleId);
      if (vehicle) {
        onVehicleUpdate({ 
          ...vehicle, 
          approval_status: 'rejected', 
          rejection_reason: rejectionReason.trim() 
        });
      }
      toast.success('Vehicle rejected');
      setRejectVehicleId(null);
      setRejectionReason('');
    } catch (err) {
      console.error('Error rejecting vehicle:', err);
      toast.error('Failed to reject vehicle');
    } finally {
      setIsRejecting(false);
    }
  };

  const toggleDriverCategory = async (vehicleTypeId: string, currentlyEnabled: boolean) => {
    if (!driver) return;

    // Check if driver has an approved vehicle compatible with this category
    const vehicleType = vehicleTypes.find(vt => vt.id === vehicleTypeId);
    const approvedVehicles = vehicles.filter(v => v.approval_status === 'approved');
    
    if (!currentlyEnabled && vehicleType) {
      const hasCompatibleVehicle = approvedVehicles.some(v => 
        v.capacity >= vehicleType.capacity
      );
      
      if (!hasCompatibleVehicle) {
        toast.warning(`Warning: Driver has no approved vehicle with capacity ≥ ${vehicleType.capacity} for ${vehicleType.name}`);
      }
    }

    const existingCategory = driverCategories.find(dc => dc.vehicle_type_id === vehicleTypeId);

    try {
      if (existingCategory) {
        const { error } = await supabase
          .from('driver_vehicle_categories')
          .update({ is_enabled: !currentlyEnabled })
          .eq('id', existingCategory.id);

        if (error) throw error;
        
        setDriverCategories(prev => 
          prev.map(dc => dc.id === existingCategory.id ? { ...dc, is_enabled: !currentlyEnabled } : dc)
        );
      } else {
        const { data, error } = await supabase
          .from('driver_vehicle_categories')
          .insert({
            driver_id: driver.id,
            vehicle_type_id: vehicleTypeId,
            is_enabled: true,
          })
          .select()
          .single();

        if (error) throw error;
        if (data) setDriverCategories(prev => [...prev, data]);
      }
      
      toast.success('Category updated');
    } catch (err) {
      console.error('Error updating category:', err);
      toast.error('Failed to update category');
    }
  };

  const isCategoryEnabled = (vehicleTypeId: string) => {
    return driverCategories.some(dc => dc.vehicle_type_id === vehicleTypeId && dc.is_enabled);
  };

  const sendOnboardingLink = async () => {
    if (!driver) return;
    setIsSendingOnboardLink(true);
    try {
      const { data, error } = await supabase.functions.invoke('stripe-onboard-driver', {
        body: { driver_id: driver.id },
      });
      if (error) throw error;
      if (data?.url) {
        // Copy link to clipboard
        await navigator.clipboard.writeText(data.url);
        toast.success('Stripe onboarding link copied to clipboard! Share it with the driver.');
        if (data.stripe_account_id && !driver.stripe_account_id) {
          onDriverUpdate({ ...driver, stripe_account_id: data.stripe_account_id });
        }
      }
    } catch (err) {
      console.error('Error generating onboarding link:', err);
      toast.error('Failed to generate Stripe onboarding link');
    } finally {
      setIsSendingOnboardLink(false);
    }
  };

  if (!driver) return null;

  const driverVehicles = vehicles.filter(v => v.driver_id === driver.id);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Driver Details</DialogTitle>
            <DialogDescription>
              View and manage driver information, vehicles, and categories
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-6">
            {/* Profile Header */}
            <div className="flex items-start gap-4">
              <Avatar className="h-20 w-20 border-2 border-border">
                <AvatarImage src={driver.profile_photo_url || ''} />
                <AvatarFallback className="text-2xl bg-primary/10 text-primary">
                  {driver.first_name[0]}{driver.last_name[0]}
                </AvatarFallback>
              </Avatar>
              <div className="flex-1">
                <h3 className="text-xl font-semibold">
                  {driver.first_name} {driver.last_name}
                </h3>
                <p className="text-sm text-muted-foreground font-mono">
                  {driver.driver_code || driver.id.slice(0, 8)}
                </p>
                <div className="flex items-center gap-2 mt-2">
                  <Badge className={getStatusColor(driver.approval_status)}>
                    {driver.approval_status}
                  </Badge>
                  <Badge
                    className={
                      driver.is_online
                        ? 'bg-green-500/10 text-green-600 border-green-500/30'
                        : 'bg-gray-500/10 text-gray-600 border-gray-500/30'
                    }
                  >
                    {driver.is_online ? 'Online' : 'Offline'}
                  </Badge>
                  {isPetFriendly && (
                    <Badge className="bg-yellow-500/10 text-yellow-700 border-yellow-500/30">
                      <PawPrint className="h-3 w-3 mr-1" />
                      Pet Friendly
                    </Badge>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1">
                <Star className="h-5 w-5 text-yellow-500 fill-yellow-500" />
                <span className="text-lg font-medium">
                  {driver.rating?.toFixed(1) || 'N/A'}
                </span>
              </div>
            </div>

            {/* Tabs */}
            <Tabs value={activeTab} onValueChange={setActiveTab}>
              <TabsList className="grid w-full grid-cols-6">
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="documents" className="relative">
                  Documents
                  {(() => {
                    const items = getDocComplianceItems();
                    const issues = items.filter(i => i.status !== 'valid' && i.status !== 'expiring_soon');
                    if (issues.length > 0) return (
                      <span className="ml-1 inline-flex items-center justify-center h-4 w-4 rounded-full bg-destructive text-destructive-foreground text-[10px] font-bold">{issues.length}</span>
                    );
                    return null;
                  })()}
                </TabsTrigger>
                <TabsTrigger value="vehicles">Vehicles ({driverVehicles.length})</TabsTrigger>
                <TabsTrigger value="commission">Commission</TabsTrigger>
                <TabsTrigger value="categories">Categories</TabsTrigger>
                <TabsTrigger value="preferences">Preferences</TabsTrigger>
              </TabsList>

              {/* Overview Tab */}
              <TabsContent value="overview" className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="flex items-center gap-3 p-3 bg-muted/50 rounded-lg">
                    <Mail className="h-5 w-5 text-muted-foreground" />
                    <div>
                      <p className="text-xs text-muted-foreground">Email</p>
                      <p className="text-sm font-medium">{driver.email}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 p-3 bg-muted/50 rounded-lg">
                    <Phone className="h-5 w-5 text-muted-foreground" />
                    <div>
                      <p className="text-xs text-muted-foreground">Phone</p>
                      <p className="text-sm font-medium">{driver.phone}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 p-3 bg-muted/50 rounded-lg">
                    <MapPin className="h-5 w-5 text-muted-foreground" />
                    <div>
                      <p className="text-xs text-muted-foreground">Region</p>
                      <p className="text-sm font-medium">
                        {regions[driver.region_id]?.name || 'Unknown'}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 p-3 bg-muted/50 rounded-lg">
                    <Car className="h-5 w-5 text-muted-foreground" />
                    <div>
                      <p className="text-xs text-muted-foreground">Total Trips</p>
                      <p className="text-sm font-medium">{driver.total_trips || 0}</p>
                    </div>
                  </div>
                </div>

                {/* Stripe Connect Status */}
                <div className="p-4 border rounded-lg space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <CreditCard className="h-5 w-5 text-muted-foreground" />
                      <h4 className="text-sm font-medium">Stripe Connect</h4>
                    </div>
                    {driver.stripe_account_id ? (
                      <Badge className={
                        driver.onboarding_complete
                          ? 'bg-green-500/10 text-green-600 border-green-500/30'
                          : 'bg-yellow-500/10 text-yellow-600 border-yellow-500/30'
                      }>
                        {driver.onboarding_complete ? 'Connected' : 'Incomplete'}
                      </Badge>
                    ) : (
                      <Badge className="bg-red-500/10 text-red-600 border-red-500/30">
                        Not Connected
                      </Badge>
                    )}
                  </div>

                  {driver.stripe_account_id ? (
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <div className="p-2 bg-muted/50 rounded">
                        <p className="text-xs text-muted-foreground">Account ID</p>
                        <p className="font-mono text-xs">{driver.stripe_account_id}</p>
                      </div>
                      <div className="p-2 bg-muted/50 rounded">
                        <p className="text-xs text-muted-foreground">Payouts</p>
                        <p className={driver.payouts_enabled ? 'text-green-600' : 'text-red-600'}>
                          {driver.payouts_enabled ? 'Enabled' : 'Disabled'}
                        </p>
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      Driver has not connected their Stripe account yet. Send an onboarding link to get started.
                    </p>
                  )}

                  <Button
                    variant="outline"
                    size="sm"
                    onClick={sendOnboardingLink}
                    disabled={isSendingOnboardLink}
                  >
                    {isSendingOnboardLink ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Send className="mr-2 h-4 w-4" />
                    )}
                    {driver.stripe_account_id ? 'Resend Onboarding Link' : 'Send Onboarding Link'}
                  </Button>
                </div>

                <div className="flex gap-2 pt-4 border-t flex-wrap">
                  <Button 
                    variant="outline"
                    onClick={() => {
                      onOpenChange(false);
                      onEditProfile(driver);
                    }}
                  >
                    <Pencil className="mr-2 h-4 w-4" />
                    Edit Profile
                  </Button>
                  <Button 
                    variant="outline"
                    onClick={() => {
                      onOpenChange(false);
                      onManageServiceAreas(driver);
                    }}
                  >
                    <Map className="mr-2 h-4 w-4" />
                    Service Areas
                  </Button>
                  {driver.approval_status !== 'approved' && (
                    <Button 
                      onClick={() => {
                        if (!canApproveDriver()) {
                          toast.error('Cannot approve: required documents are missing, pending, rejected, or expired. Check the Documents tab.');
                          setActiveTab('documents');
                          return;
                        }
                        updateDriverStatus('approved');
                      }}
                      disabled={isUpdating}
                      className="bg-green-600 hover:bg-green-700"
                    >
                      {isUpdating ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <CheckCircle className="mr-2 h-4 w-4" />
                      )}
                      Approve
                    </Button>
                  )}
                  {driver.approval_status !== 'rejected' && (
                    <Button 
                      variant="destructive"
                      onClick={() => updateDriverStatus('rejected')}
                      disabled={isUpdating}
                    >
                      {isUpdating ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <XCircle className="mr-2 h-4 w-4" />
                      )}
                      Reject
                    </Button>
                  )}
                </div>
              </TabsContent>

              {/* Documents Compliance Tab */}
              <TabsContent value="documents" className="space-y-4">
                {isLoadingDocs ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                  </div>
                ) : (() => {
                  const items = getDocComplianceItems();
                  const blocking = items.filter(i => ['missing', 'pending', 'rejected', 'expired'].includes(i.status));
                  const expiringSoon = items.filter(i => i.status === 'expiring_soon');

                  return (
                    <div className="space-y-4">
                      {/* Summary Banner */}
                      {blocking.length > 0 ? (
                        <div className="p-3 border rounded-lg bg-destructive/10 border-destructive/30 flex items-start gap-2">
                          <AlertOctagon className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
                          <div className="text-sm">
                            <p className="font-medium text-destructive">
                              Driver cannot be approved — {blocking.length} document{blocking.length > 1 ? 's' : ''} need{blocking.length === 1 ? 's' : ''} attention
                            </p>
                          </div>
                        </div>
                      ) : expiringSoon.length > 0 ? (
                        <div className="p-3 border rounded-lg bg-yellow-500/10 border-yellow-500/30 flex items-start gap-2">
                          <FileWarning className="h-4 w-4 text-yellow-600 mt-0.5 shrink-0" />
                          <div className="text-sm">
                            <p className="font-medium text-yellow-700">
                              {expiringSoon.length} document{expiringSoon.length > 1 ? 's' : ''} expiring soon
                            </p>
                            <p className="text-yellow-600/80 text-xs">
                              To avoid service disruption, ensure renewal documents are submitted before expiry.
                            </p>
                          </div>
                        </div>
                      ) : items.length > 0 ? (
                        <div className="p-3 border rounded-lg bg-green-500/10 border-green-500/30 flex items-start gap-2">
                          <CheckCircle className="h-4 w-4 text-green-600 mt-0.5 shrink-0" />
                          <p className="text-sm font-medium text-green-700">All required documents are valid</p>
                        </div>
                      ) : (
                        <div className="p-3 border rounded-lg bg-muted/50 flex items-start gap-2">
                          <Shield className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                          <p className="text-sm text-muted-foreground">No required document types configured</p>
                        </div>
                      )}

                      {/* Document List */}
                      {items.length > 0 && (
                        <div className="space-y-2">
                          {items.map((item) => {
                            const statusConfig = {
                              missing: { label: 'Missing', icon: XCircle, className: 'text-destructive bg-destructive/10 border-destructive/30' },
                              pending: { label: 'Pending Review', icon: Clock, className: 'text-yellow-700 bg-yellow-500/10 border-yellow-500/30' },
                              rejected: { label: 'Rejected', icon: XCircle, className: 'text-destructive bg-destructive/10 border-destructive/30' },
                              expired: { label: 'Expired', icon: AlertOctagon, className: 'text-destructive bg-destructive/10 border-destructive/30' },
                              expiring_soon: { label: `Expiring in ${item.daysLeft} days`, icon: FileWarning, className: 'text-yellow-700 bg-yellow-500/10 border-yellow-500/30' },
                              valid: { label: 'Valid', icon: CheckCircle, className: 'text-green-700 bg-green-500/10 border-green-500/30' },
                            }[item.status];

                            const StatusIcon = statusConfig.icon;

                            return (
                              <div key={item.slug} className="flex items-center justify-between p-3 border rounded-lg">
                                <div className="flex items-center gap-3">
                                  <FileText className="h-4 w-4 text-muted-foreground" />
                                  <span className="text-sm font-medium">{item.name}</span>
                                </div>
                                <Badge variant="outline" className={statusConfig.className}>
                                  <StatusIcon className="h-3 w-3 mr-1" />
                                  {statusConfig.label}
                                </Badge>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })()}
              </TabsContent>

              {/* Commission Tab */}
              <TabsContent value="commission" className="space-y-4">
                <div className="p-3 bg-muted/50 border rounded-lg text-sm text-muted-foreground flex items-start gap-2">
                  <Shield className="h-4 w-4 mt-0.5 shrink-0" />
                  <span>Category and commission are <strong>manually assigned</strong>. Trip progress is visual guidance only — no auto-promotion.</span>
                </div>

                {/* Category Assignment */}
                <div className="space-y-2">
                  <Label>Assign Category</Label>
                  <Select value={selectedCategoryId} onValueChange={setSelectedCategoryId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select a tier..." />
                    </SelectTrigger>
                    <SelectContent>
                      {tierCategories.map((tc: any) => (
                        <SelectItem key={tc.id} value={tc.id}>
                          {tc.name} — {tc.commission_pct}% commission
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Effective Commission Display */}
                {(() => {
                  const currentTier = tierCategories.find((tc: any) => tc.id === selectedCategoryId);
                  const effectivePct = currentTier?.commission_pct ?? null;

                  return effectivePct !== null ? (
                    <div className="p-3 border rounded-lg bg-primary/5">
                      <p className="text-sm font-medium">Effective Commission: <span className="text-primary font-bold">{effectivePct}%</span></p>
                      <p className="text-xs text-muted-foreground">
                        Using {currentTier?.name} tier rate (PostGIS Dispatch Scoring)
                      </p>
                    </div>
                  ) : null;
                })()}

                {/* Trip Progress (visual only) */}
                {(() => {
                  const currentTier = tierCategories.find((tc: any) => tc.id === selectedCategoryId);
                  const tripTarget = currentTier?.trip_target;
                  const totalTrips = driver?.total_trips || 0;

                  return currentTier && tripTarget ? (
                    <div className="p-4 border rounded-lg space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Target className="h-4 w-4 text-muted-foreground" />
                          <span className="text-sm font-medium">Trip Progress</span>
                        </div>
                        <span className="text-sm font-mono">
                          {totalTrips} / {tripTarget}
                        </span>
                      </div>
                      <Progress value={Math.min((totalTrips / tripTarget) * 100, 100)} className="h-2" />
                      <p className="text-xs text-muted-foreground">
                        Visual guidance only — does not trigger any automatic tier change.
                      </p>
                    </div>
                  ) : null;
                })()}

                <Button onClick={saveCommissionSettings} disabled={isSavingCommission}>
                  {isSavingCommission && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                  Save Commission Settings
                </Button>
              </TabsContent>

              <TabsContent value="vehicles" className="space-y-4">
                {driverVehicles.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <Car className="h-12 w-12 mx-auto mb-3 opacity-30" />
                    <p>No vehicles registered</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {driverVehicles.map((vehicle) => (
                      <div 
                        key={vehicle.id} 
                        className="p-4 border rounded-lg space-y-3"
                      >
                        <div className="flex items-start justify-between">
                          <div className="flex items-center gap-3">
                            <div className="h-12 w-12 rounded-lg bg-muted flex items-center justify-center">
                              <Car className="h-6 w-6 text-muted-foreground" />
                            </div>
                            <div>
                              <div className="flex items-center gap-2">
                                <p className="font-semibold">
                                  {vehicle.year} {vehicle.make} {vehicle.model}
                                </p>
                                {vehicle.is_primary && (
                                  <Badge variant="outline" className="text-xs">Primary</Badge>
                                )}
                              </div>
                              <p className="text-sm text-muted-foreground">
                                {vehicle.color} • {vehicle.license_plate}
                              </p>
                            </div>
                          </div>
                          <Badge className={getStatusColor(vehicle.approval_status)}>
                            {vehicle.approval_status}
                          </Badge>
                        </div>

                        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
                          <div className="flex items-center gap-2 p-2 bg-muted/50 rounded">
                            <Users className="h-4 w-4 text-muted-foreground" />
                            <span>{vehicle.capacity} seats</span>
                          </div>
                          <div className="flex items-center gap-2 p-2 bg-muted/50 rounded">
                            <Car className="h-4 w-4 text-muted-foreground" />
                            <span>{vehicle.color}</span>
                          </div>
                        </div>

                        {vehicle.rejection_reason && (
                          <div className="flex items-start gap-2 p-3 bg-red-500/10 rounded-lg text-sm">
                            <AlertTriangle className="h-4 w-4 text-red-600 mt-0.5" />
                            <div>
                              <p className="font-medium text-red-600">Rejection Reason:</p>
                              <p className="text-red-600/80">{vehicle.rejection_reason}</p>
                            </div>
                          </div>
                        )}

                        <div className="flex gap-2 pt-2 border-t">
                          {vehicle.approval_status !== 'approved' && (
                            <Button 
                              size="sm"
                              onClick={() => approveVehicle(vehicle.id)}
                              disabled={isUpdating}
                              className="bg-green-600 hover:bg-green-700"
                            >
                              <CheckCircle className="mr-1 h-3 w-3" />
                              Approve
                            </Button>
                          )}
                          {vehicle.approval_status !== 'rejected' && (
                            <Button 
                              size="sm"
                              variant="destructive"
                              onClick={() => setRejectVehicleId(vehicle.id)}
                              disabled={isUpdating}
                            >
                              <XCircle className="mr-1 h-3 w-3" />
                              Reject
                            </Button>
                          )}
                          {vehicle.approval_status !== 'pending' && (
                            <Button 
                              size="sm"
                              variant="outline"
                              onClick={async () => {
                                setIsUpdating(true);
                                try {
                                  const { error } = await supabase
                                    .from('vehicles')
                                    .update({ approval_status: 'pending', rejection_reason: null })
                                    .eq('id', vehicle.id);
                                  if (error) throw error;
                                  onVehicleUpdate({ ...vehicle, approval_status: 'pending', rejection_reason: null });
                                  toast.success('Vehicle set to pending');
                                } catch {
                                  toast.error('Failed to update vehicle');
                                } finally {
                                  setIsUpdating(false);
                                }
                              }}
                              disabled={isUpdating}
                            >
                              Set Pending
                            </Button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </TabsContent>

              {/* Categories Tab */}
              <TabsContent value="categories" className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Service categories this driver is approved to accept.
                </p>

                {(() => {
                  // Filter out default types (ONECAB) - they're always assigned automatically
                  const assignableTypes = vehicleTypes.filter(vt => !vt.is_default);
                  const defaultTypes = vehicleTypes.filter(vt => vt.is_default);
                  const enabledTypes = assignableTypes.filter(vt => isCategoryEnabled(vt.id));
                  const disabledTypes = assignableTypes.filter(vt => !isCategoryEnabled(vt.id));

                  return (
                    <>
                      {/* Default categories (always visible) */}
                      {defaultTypes.length > 0 && (
                        <div className="space-y-2">
                          {defaultTypes.map((vt) => (
                            <div 
                              key={vt.id}
                              className="flex items-center justify-between p-3 border rounded-lg border-green-500/50 bg-green-500/5"
                            >
                              <div className="flex items-center gap-3">
                                <div className="h-10 w-10 rounded-lg flex items-center justify-center bg-green-500/10 text-green-600">
                                  <Crown className="h-5 w-5" />
                                </div>
                                <div>
                                  <p className="font-medium">{vt.name}</p>
                                  <p className="text-xs text-muted-foreground">
                                    Default category • Always active
                                  </p>
                                </div>
                              </div>
                              <Badge className="bg-green-500/10 text-green-600 border-green-500/30">Default</Badge>
                            </div>
                          ))}
                        </div>
                      )}

                      {enabledTypes.length === 0 && defaultTypes.length === 0 ? (
                        <div className="text-center py-8 text-muted-foreground">
                          <Truck className="h-12 w-12 mx-auto mb-3 opacity-30" />
                          <p>No categories assigned to this driver</p>
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {enabledTypes.map((vt) => {
                            const approvedVehicles = driverVehicles.filter(v => v.approval_status === 'approved');
                            const hasCompatibleVehicle = approvedVehicles.some(v => v.capacity >= vt.capacity);

                            return (
                              <div 
                                key={vt.id}
                                className="flex items-center justify-between p-3 border rounded-lg border-primary/50 bg-primary/5"
                              >
                                <div className="flex items-center gap-3">
                                  <div className="h-10 w-10 rounded-lg flex items-center justify-center bg-primary/10 text-primary">
                                    <Truck className="h-5 w-5" />
                                  </div>
                                  <div>
                                    <p className="font-medium">{vt.name}</p>
                                    <p className="text-xs text-muted-foreground">
                                      {vt.capacity} passengers • {vt.categories?.join(', ') || 'Standard'}
                                    </p>
                                  </div>
                                </div>
                                <div className="flex items-center gap-3">
                                  {!hasCompatibleVehicle && (
                                    <Badge variant="outline" className="text-yellow-600 border-yellow-500/30 bg-yellow-500/10">
                                      <AlertTriangle className="h-3 w-3 mr-1" />
                                      No compatible vehicle
                                    </Badge>
                                  )}
                                  <Switch
                                    checked={true}
                                    onCheckedChange={() => toggleDriverCategory(vt.id, true)}
                                  />
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {disabledTypes.length > 0 && (
                        <>
                          <Button 
                            variant="outline" 
                            size="sm" 
                            onClick={() => setShowManageCategories(!showManageCategories)}
                            className="w-full"
                          >
                            {showManageCategories ? 'Hide available categories' : `Add categories (${disabledTypes.length} available)`}
                          </Button>

                          {showManageCategories && (
                            <div className="space-y-2">
                              {disabledTypes.map((vt) => (
                                <div 
                                  key={vt.id}
                                  className="flex items-center justify-between p-3 border rounded-lg"
                                >
                                  <div className="flex items-center gap-3">
                                    <div className="h-10 w-10 rounded-lg flex items-center justify-center bg-muted text-muted-foreground">
                                      <Truck className="h-5 w-5" />
                                    </div>
                                    <div>
                                      <p className="font-medium">{vt.name}</p>
                                      <p className="text-xs text-muted-foreground">
                                        {vt.capacity} passengers • {vt.categories?.join(', ') || 'Standard'}
                                      </p>
                                    </div>
                                  </div>
                                  <Switch
                                    checked={false}
                                    onCheckedChange={() => toggleDriverCategory(vt.id, false)}
                                  />
                                </div>
                              ))}
                            </div>
                          )}
                        </>
                      )}

                      {vehicleTypes.length === 0 && (
                        <div className="text-center py-8 text-muted-foreground">
                          <Truck className="h-12 w-12 mx-auto mb-3 opacity-30" />
                          <p>No vehicle types configured</p>
                        </div>
                      )}
                    </>
                  );
                })()}
              </TabsContent>

              {/* Preferences Tab */}
              <TabsContent value="preferences" className="space-y-4">
                <div className="flex items-center justify-between p-4 border rounded-lg">
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-10 rounded-lg bg-yellow-500/10 flex items-center justify-center">
                      <PawPrint className="h-5 w-5 text-yellow-600" />
                    </div>
                    <div>
                      <p className="font-medium">Pet Friendly</p>
                      <p className="text-xs text-muted-foreground">
                        Accept rides with pets. This affects trip matching for pet-friendly requests.
                      </p>
                    </div>
                  </div>
                  <Switch
                    checked={isPetFriendly}
                    onCheckedChange={updatePetFriendly}
                  />
                </div>

                <div className="p-4 border rounded-lg bg-muted/30">
                  <div className="flex items-center gap-2 mb-2">
                    <Shield className="h-4 w-4 text-muted-foreground" />
                    <p className="text-sm font-medium">Coming Soon</p>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Additional driver preferences (wheelchair accessible, child seat, luggage capacity) 
                    will be available in a future update.
                  </p>
                </div>
              </TabsContent>
            </Tabs>
          </div>
        </DialogContent>
      </Dialog>

      {/* Vehicle Rejection Dialog */}
      <AlertDialog open={!!rejectVehicleId} onOpenChange={(open) => !open && setRejectVehicleId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reject Vehicle</AlertDialogTitle>
            <AlertDialogDescription>
              Please provide a reason for rejecting this vehicle. This will be visible to the driver.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="py-4">
            <Label htmlFor="rejection_reason">Rejection Reason</Label>
            <Textarea
              id="rejection_reason"
              value={rejectionReason}
              onChange={(e) => setRejectionReason(e.target.value)}
              placeholder="e.g., Vehicle does not meet minimum age requirements, Insurance expired..."
              className="mt-2"
              rows={3}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isRejecting}>Cancel</AlertDialogCancel>
            <AlertDialogAction 
              onClick={rejectVehicle}
              disabled={isRejecting || !rejectionReason.trim()}
              className="bg-destructive hover:bg-destructive/90"
            >
              {isRejecting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Reject Vehicle
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
