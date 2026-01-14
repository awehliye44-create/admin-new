import { useEffect, useState, useCallback } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
  Users, Loader2, Search, MoreVertical, Eye, 
  Trash2, Phone, Car,
  RefreshCw, UserCheck, UserX, Clock, Calendar
} from 'lucide-react';
import { format, formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import { RiderDetailsDialog } from '@/components/riders/RiderDetailsDialog';

// Rider-specific interface - NO driver fields (no vehicles, documents, service areas, etc.)
interface Rider {
  id: string;
  user_id: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  created_at: string;
  updated_at: string;
  trip_count?: number;
  last_trip_at?: string | null;
  status?: 'active' | 'suspended';
  wallet_balance?: number;
  default_payment_method?: string | null;
}

export default function Riders() {
  const [riders, setRiders] = useState<Rider[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedRider, setSelectedRider] = useState<Rider | null>(null);
  const [isViewDialogOpen, setIsViewDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [riderToDelete, setRiderToDelete] = useState<Rider | null>(null);

  const fetchRiders = useCallback(async () => {
    try {
      setIsLoading(true);
      
      // Fetch riders from customers table (NOT drivers table)
      const { data: ridersData, error: ridersError } = await supabase
        .from('customers')
        .select('*')
        .order('created_at', { ascending: false });

      if (ridersError) throw ridersError;

      // Fetch trip counts for each rider
      const ridersWithStats = await Promise.all(
        (ridersData || []).map(async (rider) => {
          const { count, data: trips } = await supabase
            .from('trips')
            .select('id, created_at', { count: 'exact' })
            .eq('passenger_id', rider.user_id)
            .order('created_at', { ascending: false })
            .limit(1);

          return {
            ...rider,
            trip_count: count || 0,
            last_trip_at: trips?.[0]?.created_at || null,
            status: 'active' as const,
          };
        })
      );

      setRiders(ridersWithStats);
    } catch (err) {
      console.error('Error fetching riders:', err);
      toast.error('Failed to load riders');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRiders();
  }, [fetchRiders]);

  const handleViewRider = (rider: Rider) => {
    setSelectedRider(rider);
    setIsViewDialogOpen(true);
  };

  const handleDeleteClick = (rider: Rider) => {
    setRiderToDelete(rider);
    setIsDeleteDialogOpen(true);
  };

  const handleDeleteConfirm = async () => {
    if (!riderToDelete) return;

    try {
      const { error } = await supabase
        .from('customers')
        .delete()
        .eq('id', riderToDelete.id);

      if (error) throw error;

      setRiders(prev => prev.filter(r => r.id !== riderToDelete.id));
      toast.success('Rider deleted successfully');
    } catch (err) {
      console.error('Error deleting rider:', err);
      toast.error('Failed to delete rider');
    } finally {
      setIsDeleteDialogOpen(false);
      setRiderToDelete(null);
    }
  };

  const handleRiderUpdate = (updatedRider: Rider) => {
    setRiders(prev => prev.map(r => r.id === updatedRider.id ? updatedRider : r));
    setSelectedRider(updatedRider);
  };

  const getInitials = (firstName: string | null, lastName: string | null) => {
    const first = firstName?.charAt(0)?.toUpperCase() || '';
    const last = lastName?.charAt(0)?.toUpperCase() || '';
    return first + last || '?';
  };

  const getFullName = (rider: Rider) => {
    if (rider.first_name || rider.last_name) {
      return `${rider.first_name || ''} ${rider.last_name || ''}`.trim();
    }
    return 'Unknown';
  };

  const filteredRiders = riders.filter(rider => {
    const fullName = getFullName(rider).toLowerCase();
    const phone = rider.phone?.toLowerCase() || '';
    const query = searchQuery.toLowerCase();
    return fullName.includes(query) || phone.includes(query);
  });

  const totalRiders = riders.length;
  const activeRiders = riders.filter(r => r.trip_count && r.trip_count > 0).length;
  const newThisMonth = riders.filter(r => {
    const created = new Date(r.created_at);
    const now = new Date();
    return created.getMonth() === now.getMonth() && created.getFullYear() === now.getFullYear();
  }).length;

  return (
    <AdminLayout 
      title="Riders" 
      description="Manage registered riders (customers) from your apps"
    >
      {/* Stats Cards - Rider-specific stats only */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Total Riders</p>
                <p className="text-2xl font-bold">{totalRiders}</p>
              </div>
              <Users className="h-8 w-8 text-primary opacity-80" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-green-500/30 bg-green-500/5">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Active Riders</p>
                <p className="text-2xl font-bold text-green-600">{activeRiders}</p>
              </div>
              <UserCheck className="h-8 w-8 text-green-500" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-blue-500/30 bg-blue-500/5">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">New This Month</p>
                <p className="text-2xl font-bold text-blue-600">{newThisMonth}</p>
              </div>
              <Calendar className="h-8 w-8 text-blue-500" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-gray-500/30 bg-gray-500/5">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Never Booked</p>
                <p className="text-2xl font-bold text-gray-600">{totalRiders - activeRiders}</p>
              </div>
              <UserX className="h-8 w-8 text-gray-400" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Main Table */}
      <Card>
        <CardHeader className="pb-4">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Users className="h-5 w-5 text-primary" />
                All Riders
              </CardTitle>
              <CardDescription>{filteredRiders.length} riders</CardDescription>
            </div>
            <div className="flex items-center gap-3">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search by name or phone..."
                  className="pl-9 w-[250px]"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
              <Button variant="outline" size="icon" onClick={fetchRiders}>
                <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
          ) : filteredRiders.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              {searchQuery ? 'No riders match your search' : 'No riders registered yet'}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Rider</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Trips</TableHead>
                  <TableHead>Last Trip</TableHead>
                  <TableHead>Joined</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredRiders.map((rider) => (
                  <TableRow key={rider.id}>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <Avatar className="h-9 w-9">
                          <AvatarFallback className="bg-primary/10 text-primary text-sm">
                            {getInitials(rider.first_name, rider.last_name)}
                          </AvatarFallback>
                        </Avatar>
                        <div>
                          <p className="font-medium">{getFullName(rider)}</p>
                          <p className="text-xs text-muted-foreground">
                            ID: {rider.id.slice(0, 8)}...
                          </p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      {rider.phone ? (
                        <div className="flex items-center gap-1">
                          <Phone className="h-3 w-3 text-muted-foreground" />
                          <span>{rider.phone}</span>
                        </div>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={rider.trip_count && rider.trip_count > 0 ? 'default' : 'secondary'}>
                        <Car className="h-3 w-3 mr-1" />
                        {rider.trip_count || 0}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {rider.last_trip_at ? (
                        <span className="text-sm">
                          {formatDistanceToNow(new Date(rider.last_trip_at), { addSuffix: true })}
                        </span>
                      ) : (
                        <span className="text-muted-foreground text-sm">Never</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1 text-sm text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        {format(new Date(rider.created_at), 'MMM d, yyyy')}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon">
                            <MoreVertical className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => handleViewRider(rider)}>
                            <Eye className="h-4 w-4 mr-2" />
                            View Details
                          </DropdownMenuItem>
                          <DropdownMenuItem 
                            onClick={() => handleDeleteClick(rider)}
                            className="text-destructive"
                          >
                            <Trash2 className="h-4 w-4 mr-2" />
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

      {/* Rider Details Dialog - Rider-specific only */}
      <RiderDetailsDialog
        open={isViewDialogOpen}
        onOpenChange={setIsViewDialogOpen}
        rider={selectedRider}
        onRiderUpdate={handleRiderUpdate}
      />

      {/* Delete Confirmation */}
      <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Rider</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete {riderToDelete && getFullName(riderToDelete)}? 
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteConfirm}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AdminLayout>
  );
}
