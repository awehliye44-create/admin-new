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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
  Plus, Users, Loader2, Search, MoreVertical, Eye, 
  Trash2, Phone, Mail, Calendar, MapPin, Car, Star,
  RefreshCw, UserCheck, UserX, Clock
} from 'lucide-react';
import { format, formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';

interface Customer {
  id: string;
  user_id: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  created_at: string;
  updated_at: string;
  trip_count?: number;
  last_trip_at?: string | null;
}

export default function Riders() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [isViewDialogOpen, setIsViewDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [customerToDelete, setCustomerToDelete] = useState<Customer | null>(null);

  const fetchCustomers = useCallback(async () => {
    try {
      setIsLoading(true);
      
      // Fetch customers
      const { data: customersData, error: customersError } = await supabase
        .from('customers')
        .select('*')
        .order('created_at', { ascending: false });

      if (customersError) throw customersError;

      // Fetch trip counts for each customer
      const customersWithStats = await Promise.all(
        (customersData || []).map(async (customer) => {
          const { count, data: trips } = await supabase
            .from('trips')
            .select('id, created_at', { count: 'exact' })
            .eq('passenger_id', customer.user_id)
            .order('created_at', { ascending: false })
            .limit(1);

          return {
            ...customer,
            trip_count: count || 0,
            last_trip_at: trips?.[0]?.created_at || null,
          };
        })
      );

      setCustomers(customersWithStats);
    } catch (err) {
      console.error('Error fetching customers:', err);
      toast.error('Failed to load riders');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCustomers();
  }, [fetchCustomers]);

  const handleViewCustomer = (customer: Customer) => {
    setSelectedCustomer(customer);
    setIsViewDialogOpen(true);
  };

  const handleDeleteClick = (customer: Customer) => {
    setCustomerToDelete(customer);
    setIsDeleteDialogOpen(true);
  };

  const handleDeleteConfirm = async () => {
    if (!customerToDelete) return;

    try {
      const { error } = await supabase
        .from('customers')
        .delete()
        .eq('id', customerToDelete.id);

      if (error) throw error;

      setCustomers(prev => prev.filter(c => c.id !== customerToDelete.id));
      toast.success('Rider deleted successfully');
    } catch (err) {
      console.error('Error deleting customer:', err);
      toast.error('Failed to delete rider');
    } finally {
      setIsDeleteDialogOpen(false);
      setCustomerToDelete(null);
    }
  };

  const getInitials = (firstName: string | null, lastName: string | null) => {
    const first = firstName?.charAt(0)?.toUpperCase() || '';
    const last = lastName?.charAt(0)?.toUpperCase() || '';
    return first + last || '?';
  };

  const getFullName = (customer: Customer) => {
    if (customer.first_name || customer.last_name) {
      return `${customer.first_name || ''} ${customer.last_name || ''}`.trim();
    }
    return 'Unknown';
  };

  const filteredCustomers = customers.filter(customer => {
    const fullName = getFullName(customer).toLowerCase();
    const phone = customer.phone?.toLowerCase() || '';
    const query = searchQuery.toLowerCase();
    return fullName.includes(query) || phone.includes(query);
  });

  const totalRiders = customers.length;
  const activeRiders = customers.filter(c => c.trip_count && c.trip_count > 0).length;
  const newThisMonth = customers.filter(c => {
    const created = new Date(c.created_at);
    const now = new Date();
    return created.getMonth() === now.getMonth() && created.getFullYear() === now.getFullYear();
  }).length;

  return (
    <AdminLayout 
      title="Riders" 
      description="Manage registered customers from your apps"
    >
      {/* Stats Cards */}
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
              <CardDescription>{filteredCustomers.length} riders</CardDescription>
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
              <Button variant="outline" size="icon" onClick={fetchCustomers}>
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
          ) : filteredCustomers.length === 0 ? (
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
                {filteredCustomers.map((customer) => (
                  <TableRow key={customer.id}>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <Avatar className="h-9 w-9">
                          <AvatarFallback className="bg-primary/10 text-primary text-sm">
                            {getInitials(customer.first_name, customer.last_name)}
                          </AvatarFallback>
                        </Avatar>
                        <div>
                          <p className="font-medium">{getFullName(customer)}</p>
                          <p className="text-xs text-muted-foreground">
                            ID: {customer.id.slice(0, 8)}...
                          </p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      {customer.phone ? (
                        <div className="flex items-center gap-1">
                          <Phone className="h-3 w-3 text-muted-foreground" />
                          <span>{customer.phone}</span>
                        </div>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={customer.trip_count && customer.trip_count > 0 ? 'default' : 'secondary'}>
                        <Car className="h-3 w-3 mr-1" />
                        {customer.trip_count || 0}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {customer.last_trip_at ? (
                        <span className="text-sm">
                          {formatDistanceToNow(new Date(customer.last_trip_at), { addSuffix: true })}
                        </span>
                      ) : (
                        <span className="text-muted-foreground text-sm">Never</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1 text-sm text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        {format(new Date(customer.created_at), 'MMM d, yyyy')}
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
                          <DropdownMenuItem onClick={() => handleViewCustomer(customer)}>
                            <Eye className="h-4 w-4 mr-2" />
                            View Details
                          </DropdownMenuItem>
                          <DropdownMenuItem 
                            onClick={() => handleDeleteClick(customer)}
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

      {/* View Dialog */}
      <Dialog open={isViewDialogOpen} onOpenChange={setIsViewDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rider Details</DialogTitle>
            <DialogDescription>
              Customer information and activity
            </DialogDescription>
          </DialogHeader>
          {selectedCustomer && (
            <div className="space-y-4">
              <div className="flex items-center gap-4">
                <Avatar className="h-16 w-16">
                  <AvatarFallback className="bg-primary/10 text-primary text-xl">
                    {getInitials(selectedCustomer.first_name, selectedCustomer.last_name)}
                  </AvatarFallback>
                </Avatar>
                <div>
                  <h3 className="text-xl font-semibold">{getFullName(selectedCustomer)}</h3>
                  <p className="text-muted-foreground text-sm">
                    Member since {format(new Date(selectedCustomer.created_at), 'MMMM yyyy')}
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="p-3 bg-muted/50 rounded-lg">
                  <div className="flex items-center gap-2 text-muted-foreground mb-1">
                    <Phone className="h-4 w-4" />
                    <span className="text-xs">Phone</span>
                  </div>
                  <p className="font-medium">{selectedCustomer.phone || 'Not provided'}</p>
                </div>
                <div className="p-3 bg-muted/50 rounded-lg">
                  <div className="flex items-center gap-2 text-muted-foreground mb-1">
                    <Car className="h-4 w-4" />
                    <span className="text-xs">Total Trips</span>
                  </div>
                  <p className="font-medium">{selectedCustomer.trip_count || 0}</p>
                </div>
                <div className="p-3 bg-muted/50 rounded-lg">
                  <div className="flex items-center gap-2 text-muted-foreground mb-1">
                    <Calendar className="h-4 w-4" />
                    <span className="text-xs">Last Trip</span>
                  </div>
                  <p className="font-medium">
                    {selectedCustomer.last_trip_at 
                      ? format(new Date(selectedCustomer.last_trip_at), 'MMM d, yyyy')
                      : 'Never'
                    }
                  </p>
                </div>
                <div className="p-3 bg-muted/50 rounded-lg">
                  <div className="flex items-center gap-2 text-muted-foreground mb-1">
                    <Clock className="h-4 w-4" />
                    <span className="text-xs">Last Updated</span>
                  </div>
                  <p className="font-medium">
                    {format(new Date(selectedCustomer.updated_at), 'MMM d, yyyy')}
                  </p>
                </div>
              </div>

              <div className="p-3 bg-muted/30 rounded-lg">
                <p className="text-xs text-muted-foreground mb-1">User ID</p>
                <p className="font-mono text-sm">{selectedCustomer.user_id}</p>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Rider</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete {customerToDelete && getFullName(customerToDelete)}? 
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
