import { useEffect, useState, useCallback } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { 
  MessageSquare, Loader2, Search, Star, RefreshCw,
  Eye, CheckCircle, XCircle, Clock, Car, User, Filter, Plus,
  ChevronLeft, ChevronRight, AlertTriangle
} from 'lucide-react';
import { format, formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';

interface RiderFeedback {
  id: string;
  trip_id: string | null;
  customer_id: string;
  driver_id: string | null;
  rating: number;
  comment: string | null;
  feedback_type: string;
  status: string;
  admin_notes: string | null;
  created_at: string;
  updated_at: string;
  customer?: {
    first_name: string | null;
    last_name: string | null;
    phone: string | null;
  };
  driver?: {
    first_name: string;
    last_name: string;
  };
  trip?: {
    pickup_address: string;
    dropoff_address: string;
  };
}

interface Customer {
  user_id: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
}

interface Driver {
  id: string;
  first_name: string;
  last_name: string;
}

interface Trip {
  id: string;
  trip_code: string | null;
  pickup_address: string;
  dropoff_address: string;
  passenger_id: string;
}

const PAGE_SIZE = 20;

const STATUS_OPTIONS = [
  { value: 'pending', label: 'Pending', color: 'bg-yellow-100 text-yellow-700 border-yellow-200' },
  { value: 'reviewed', label: 'Reviewed', color: 'bg-blue-100 text-blue-700 border-blue-200' },
  { value: 'resolved', label: 'Resolved', color: 'bg-green-100 text-green-700 border-green-200' },
  { value: 'dismissed', label: 'Dismissed', color: 'bg-gray-100 text-gray-600 border-gray-200' },
];

const TYPE_OPTIONS = [
  { value: 'trip', label: 'Trip Feedback' },
  { value: 'app', label: 'App Issue' },
  { value: 'support', label: 'Support Request' },
  { value: 'general', label: 'General' },
];

export default function RiderFeedback() {
  const [feedback, setFeedback] = useState<RiderFeedback[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [selectedFeedback, setSelectedFeedback] = useState<RiderFeedback | null>(null);
  const [isViewDialogOpen, setIsViewDialogOpen] = useState(false);
  const [adminNotes, setAdminNotes] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  // Pagination
  const [page, setPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  // Stats (fetched once, separate from paginated data)
  const [stats, setStats] = useState({ total: 0, pending: 0, avgRating: '0.0', lowRating: 0 });

  // New feedback form state
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [newFeedback, setNewFeedback] = useState({
    customer_id: '',
    driver_id: '',
    trip_id: '',
    rating: 5,
    comment: '',
    feedback_type: 'trip',
  });
  const [isCreating, setIsCreating] = useState(false);

  // Reset to page 1 when filters change
  useEffect(() => {
    setPage(1);
  }, [searchQuery, statusFilter, typeFilter]);

  const fetchStats = useCallback(async () => {
    try {
      const { count: total } = await supabase
        .from('rider_feedback')
        .select('*', { count: 'exact', head: true });

      const { count: pending } = await supabase
        .from('rider_feedback')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'pending');

      const { data: ratingData } = await supabase
        .from('rider_feedback')
        .select('rating');

      const { count: lowRating } = await supabase
        .from('rider_feedback')
        .select('*', { count: 'exact', head: true })
        .lte('rating', 2);

      const ratings = ratingData || [];
      const avg = ratings.length > 0
        ? (ratings.reduce((sum, r) => sum + r.rating, 0) / ratings.length).toFixed(1)
        : '0.0';

      setStats({
        total: total || 0,
        pending: pending || 0,
        avgRating: avg,
        lowRating: lowRating || 0,
      });
    } catch (err) {
      console.error('Error fetching stats:', err);
    }
  }, []);

  const fetchFeedback = useCallback(async (isBackground = false) => {
    try {
      if (!isBackground) {
        setIsLoading(true);
        setError(null);
      }

      const offset = (page - 1) * PAGE_SIZE;

      // Build query with server-side filters
      let query = supabase
        .from('rider_feedback')
        .select(`
          id, trip_id, customer_id, driver_id, rating, comment, feedback_type, status, admin_notes, created_at, updated_at,
          driver:drivers(first_name, last_name),
          trip:trips(pickup_address, dropoff_address)
        `, { count: 'exact' })
        .order('created_at', { ascending: false });

      if (statusFilter !== 'all') {
        query = query.eq('status', statusFilter);
      }
      if (typeFilter !== 'all') {
        query = query.eq('feedback_type', typeFilter);
      }
      if (searchQuery.trim()) {
        query = query.or(`comment.ilike.%${searchQuery.trim()}%`);
      }

      query = query.range(offset, offset + PAGE_SIZE - 1);

      const { data, error: queryError, count } = await query;

      if (queryError) throw queryError;

      setTotalCount(count || 0);

      // Batch-fetch customer info for all customer_ids on this page
      const customerIds = [...new Set((data || []).map(d => d.customer_id))];
      let customerMap: Record<string, { first_name: string | null; last_name: string | null; phone: string | null }> = {};

      if (customerIds.length > 0) {
        // Try matching by customers.id first (rider_feedback.customer_id → customers.id)
        const { data: customersById } = await supabase
          .from('customers')
          .select('id, user_id, first_name, last_name, phone')
          .in('id', customerIds);

        if (customersById && customersById.length > 0) {
          customerMap = Object.fromEntries(customersById.map(c => [c.id, c]));
        } else {
          // Fallback: match by user_id for legacy data
          const { data: customersByUserId } = await supabase
            .from('customers')
            .select('id, user_id, first_name, last_name, phone')
            .in('user_id', customerIds);

          if (customersByUserId) {
            customerMap = Object.fromEntries(customersByUserId.map(c => [c.user_id, c]));
          }
        }
      }

      const feedbackWithCustomers = (data || []).map(item => ({
        ...item,
        customer: customerMap[item.customer_id] || null,
      }));

      setFeedback(feedbackWithCustomers);
    } catch (err) {
      console.error('Error fetching feedback:', err);
      const message = err instanceof Error ? err.message : 'Failed to load feedback';
      setError(message);
      if (isBackground) toast.error('Failed to refresh feedback');
    } finally {
      setIsLoading(false);
    }
  }, [page, statusFilter, typeFilter, searchQuery]);

  const fetchFormData = useCallback(async () => {
    try {
      const [customersRes, driversRes, tripsRes] = await Promise.all([
        supabase.from('customers').select('user_id, first_name, last_name, phone').order('first_name'),
        supabase.from('drivers').select('id, first_name, last_name').eq('approval_status', 'approved').order('first_name'),
        supabase.from('trips').select('id, trip_code, pickup_address, dropoff_address, passenger_id').eq('status', 'completed').order('created_at', { ascending: false }).limit(100),
      ]);

      if (customersRes.data) setCustomers(customersRes.data);
      if (driversRes.data) setDrivers(driversRes.data);
      if (tripsRes.data) setTrips(tripsRes.data);
    } catch (err) {
      console.error('Error fetching form data:', err);
    }
  }, []);

  useEffect(() => {
    fetchFeedback();
  }, [fetchFeedback]);

  useEffect(() => {
    fetchStats();
    fetchFormData();
  }, [fetchStats, fetchFormData]);

  const handleRefresh = () => {
    fetchFeedback();
    fetchStats();
  };

  const handleOpenCreateDialog = () => {
    setNewFeedback({
      customer_id: '',
      driver_id: '',
      trip_id: '',
      rating: 5,
      comment: '',
      feedback_type: 'trip',
    });
    setIsCreateDialogOpen(true);
  };

  const handleCreateFeedback = async () => {
    if (!newFeedback.customer_id) {
      toast.error('Please select a customer');
      return;
    }

    try {
      setIsCreating(true);
      const { error } = await supabase.from('rider_feedback').insert({
        customer_id: newFeedback.customer_id,
        driver_id: newFeedback.driver_id || null,
        trip_id: newFeedback.trip_id || null,
        rating: newFeedback.rating,
        comment: newFeedback.comment || null,
        feedback_type: newFeedback.feedback_type,
        status: 'pending',
      });

      if (error) throw error;

      toast.success('Feedback recorded successfully');
      setIsCreateDialogOpen(false);
      handleRefresh();
    } catch (err) {
      console.error('Error creating feedback:', err);
      toast.error('Failed to record feedback');
    } finally {
      setIsCreating(false);
    }
  };

  const handleTripSelect = (tripId: string) => {
    setNewFeedback(prev => ({ ...prev, trip_id: tripId }));
    const selectedTrip = trips.find(t => t.id === tripId);
    if (selectedTrip) {
      setNewFeedback(prev => ({ ...prev, customer_id: selectedTrip.passenger_id }));
    }
  };

  const handleViewFeedback = (item: RiderFeedback) => {
    setSelectedFeedback(item);
    setAdminNotes(item.admin_notes || '');
    setIsViewDialogOpen(true);
  };

  const handleUpdateStatus = async (newStatus: string) => {
    if (!selectedFeedback) return;

    try {
      setIsSaving(true);
      const { error } = await supabase
        .from('rider_feedback')
        .update({ 
          status: newStatus,
          admin_notes: adminNotes,
        })
        .eq('id', selectedFeedback.id);

      if (error) throw error;

      setFeedback(prev => prev.map(f => 
        f.id === selectedFeedback.id 
          ? { ...f, status: newStatus, admin_notes: adminNotes }
          : f
      ));
      
      toast.success(`Feedback marked as ${newStatus}`);
      setIsViewDialogOpen(false);
      fetchStats(); // Update stats after status change
    } catch (err) {
      console.error('Error updating feedback:', err);
      toast.error('Failed to update feedback');
    } finally {
      setIsSaving(false);
    }
  };

  const getCustomerName = (customer: RiderFeedback['customer']) => {
    if (customer?.first_name || customer?.last_name) {
      return `${customer.first_name || ''} ${customer.last_name || ''}`.trim();
    }
    return 'Unknown';
  };

  const getDriverName = (driver: RiderFeedback['driver']) => {
    if (driver) {
      return `${driver.first_name} ${driver.last_name}`;
    }
    return 'N/A';
  };

  const getStatusBadge = (status: string) => {
    const option = STATUS_OPTIONS.find(o => o.value === status);
    return option || STATUS_OPTIONS[0];
  };

  const renderStars = (rating: number) => {
    return (
      <div className="flex items-center gap-0.5">
        {[1, 2, 3, 4, 5].map((star) => (
          <Star
            key={star}
            className={`h-4 w-4 ${
              star <= rating ? 'fill-yellow-400 text-yellow-400' : 'text-muted-foreground/30'
            }`}
          />
        ))}
      </div>
    );
  };

  const rangeStart = totalCount === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const rangeEnd = Math.min(page * PAGE_SIZE, totalCount);

  return (
    <AdminLayout 
      title="Rider Feedback" 
      description="Customer reviews and feedback from trips"
    >
      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Total Feedback</p>
                <p className="text-2xl font-bold">{stats.total}</p>
              </div>
              <MessageSquare className="h-8 w-8 text-primary opacity-80" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-yellow-500/30 bg-yellow-500/5">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Pending Review</p>
                <p className="text-2xl font-bold text-yellow-600">{stats.pending}</p>
              </div>
              <Clock className="h-8 w-8 text-yellow-500" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-amber-500/30 bg-amber-500/5">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Avg Rating</p>
                <div className="flex items-center gap-2">
                  <p className="text-2xl font-bold text-amber-600">{stats.avgRating}</p>
                  <Star className="h-5 w-5 fill-yellow-400 text-yellow-400" />
                </div>
              </div>
              <Star className="h-8 w-8 text-amber-500" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-red-500/30 bg-red-500/5">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Low Ratings (≤2)</p>
                <p className="text-2xl font-bold text-red-600">{stats.lowRating}</p>
              </div>
              <XCircle className="h-8 w-8 text-red-500" />
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
                <MessageSquare className="h-5 w-5 text-primary" />
                All Feedback
              </CardTitle>
              <CardDescription>
                {totalCount} total {statusFilter !== 'all' || typeFilter !== 'all' || searchQuery ? '(filtered)' : ''}
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={handleOpenCreateDialog}>
                <Plus className="h-4 w-4 mr-2" />
                Record Feedback
              </Button>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search comments..."
                  className="pl-9 w-[180px]"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-[130px]">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Status</SelectItem>
                  {STATUS_OPTIONS.map(opt => (
                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={typeFilter} onValueChange={setTypeFilter}>
                <SelectTrigger className="w-[130px]">
                  <SelectValue placeholder="Type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  {TYPE_OPTIONS.map(opt => (
                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button variant="outline" size="icon" onClick={handleRefresh}>
                <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex flex-col items-center justify-center py-12 text-center space-y-3">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <p className="text-sm text-muted-foreground">Loading feedback…</p>
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center py-12 px-4 text-center space-y-4">
              <div className="w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center">
                <AlertTriangle className="h-6 w-6 text-destructive" />
              </div>
              <div className="space-y-1">
                <h3 className="text-lg font-semibold text-foreground">Failed to load feedback</h3>
                <p className="text-sm text-muted-foreground max-w-sm">{error}</p>
              </div>
              <Button variant="outline" onClick={() => fetchFeedback()}>
                <RefreshCw className="h-4 w-4 mr-2" />
                Try Again
              </Button>
            </div>
          ) : feedback.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center space-y-2">
              <MessageSquare className="h-10 w-10 text-muted-foreground/40" />
              <p className="text-muted-foreground">
                {statusFilter !== 'all' || typeFilter !== 'all' || searchQuery
                  ? 'No feedback matches your filters'
                  : 'No feedback submitted yet. Feedback will appear here when customers rate their trips.'}
              </p>
            </div>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Customer</TableHead>
                    <TableHead>Rating</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Comment</TableHead>
                    <TableHead>Driver</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {feedback.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Avatar className="h-8 w-8">
                            <AvatarFallback className="bg-primary/10 text-primary text-xs">
                              {getCustomerName(item.customer).charAt(0)}
                            </AvatarFallback>
                          </Avatar>
                          <span className="font-medium">{getCustomerName(item.customer)}</span>
                        </div>
                      </TableCell>
                      <TableCell>{renderStars(item.rating)}</TableCell>
                      <TableCell>
                        <Badge variant="outline">
                          {TYPE_OPTIONS.find(t => t.value === item.feedback_type)?.label || item.feedback_type}
                        </Badge>
                      </TableCell>
                      <TableCell className="max-w-[200px]">
                        <p className="truncate text-sm text-muted-foreground">
                          {item.comment || '—'}
                        </p>
                      </TableCell>
                      <TableCell>
                        {item.driver ? (
                          <div className="flex items-center gap-1">
                            <Car className="h-3 w-3 text-muted-foreground" />
                            <span className="text-sm">{getDriverName(item.driver)}</span>
                          </div>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={getStatusBadge(item.status).color}>
                          {getStatusBadge(item.status).label}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {formatDistanceToNow(new Date(item.created_at), { addSuffix: true })}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button 
                          variant="ghost" 
                          size="sm"
                          onClick={() => handleViewFeedback(item)}
                        >
                          <Eye className="h-4 w-4 mr-1" />
                          View
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              {/* Pagination */}
              <div className="flex items-center justify-between pt-4 border-t mt-4">
                <p className="text-sm text-muted-foreground">
                  Showing {rangeStart}–{rangeEnd} of {totalCount}
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page <= 1}
                    onClick={() => setPage(p => p - 1)}
                  >
                    <ChevronLeft className="h-4 w-4 mr-1" />
                    Previous
                  </Button>
                  <span className="text-sm text-muted-foreground px-2">
                    Page {page} of {totalPages}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page >= totalPages}
                    onClick={() => setPage(p => p + 1)}
                  >
                    Next
                    <ChevronRight className="h-4 w-4 ml-1" />
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* View/Update Dialog */}
      <Dialog open={isViewDialogOpen} onOpenChange={setIsViewDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Feedback Details</DialogTitle>
            <DialogDescription>
              Review and respond to customer feedback
            </DialogDescription>
          </DialogHeader>
          {selectedFeedback && (
            <div className="space-y-4">
              {/* Customer & Rating */}
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <Avatar className="h-12 w-12">
                    <AvatarFallback className="bg-primary/10 text-primary">
                      {getCustomerName(selectedFeedback.customer).charAt(0)}
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <p className="font-medium">{getCustomerName(selectedFeedback.customer)}</p>
                    <p className="text-sm text-muted-foreground">
                      {format(new Date(selectedFeedback.created_at), 'MMM d, yyyy h:mm a')}
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  {renderStars(selectedFeedback.rating)}
                  <p className="text-sm text-muted-foreground mt-1">
                    {selectedFeedback.rating}/5 stars
                  </p>
                </div>
              </div>

              {/* Comment */}
              {selectedFeedback.comment && (
                <div className="p-3 bg-muted/50 rounded-lg">
                  <p className="text-sm font-medium mb-1">Customer Comment</p>
                  <p className="text-sm">{selectedFeedback.comment}</p>
                </div>
              )}

              {/* Trip & Driver Info */}
              <div className="grid grid-cols-2 gap-3">
                <div className="p-3 bg-muted/50 rounded-lg">
                  <p className="text-xs text-muted-foreground mb-1">Driver</p>
                  <p className="font-medium text-sm">{getDriverName(selectedFeedback.driver)}</p>
                </div>
                <div className="p-3 bg-muted/50 rounded-lg">
                  <p className="text-xs text-muted-foreground mb-1">Type</p>
                  <p className="font-medium text-sm">
                    {TYPE_OPTIONS.find(t => t.value === selectedFeedback.feedback_type)?.label}
                  </p>
                </div>
              </div>

              {selectedFeedback.trip && (
                <div className="p-3 bg-muted/50 rounded-lg">
                  <p className="text-xs text-muted-foreground mb-1">Trip Details</p>
                  <p className="text-sm">
                    <span className="font-medium">From:</span> {selectedFeedback.trip.pickup_address}
                  </p>
                  <p className="text-sm">
                    <span className="font-medium">To:</span> {selectedFeedback.trip.dropoff_address}
                  </p>
                </div>
              )}

              {/* Admin Notes */}
              <div className="space-y-2">
                <label className="text-sm font-medium">Admin Notes</label>
                <Textarea
                  value={adminNotes}
                  onChange={(e) => setAdminNotes(e.target.value)}
                  placeholder="Add internal notes about this feedback..."
                  rows={3}
                />
              </div>

              {/* Status Actions */}
              <div className="flex items-center justify-between pt-2">
                <Badge variant="outline" className={getStatusBadge(selectedFeedback.status).color}>
                  Current: {getStatusBadge(selectedFeedback.status).label}
                </Badge>
              </div>
            </div>
          )}
          <DialogFooter className="flex-wrap gap-2">
            <Button 
              variant="outline" 
              onClick={() => handleUpdateStatus('dismissed')}
              disabled={isSaving}
            >
              <XCircle className="h-4 w-4 mr-2" />
              Dismiss
            </Button>
            <Button 
              variant="outline"
              onClick={() => handleUpdateStatus('reviewed')}
              disabled={isSaving}
            >
              <Eye className="h-4 w-4 mr-2" />
              Mark Reviewed
            </Button>
            <Button 
              onClick={() => handleUpdateStatus('resolved')}
              disabled={isSaving}
            >
              {isSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              <CheckCircle className="h-4 w-4 mr-2" />
              Resolve
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create Feedback Dialog */}
      <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Record Rider Feedback</DialogTitle>
            <DialogDescription>
              Submit feedback and rating from a customer
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {/* Trip Selection (optional) */}
            <div className="space-y-2">
              <Label>Trip (Optional)</Label>
              <Select value={newFeedback.trip_id} onValueChange={handleTripSelect}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a completed trip..." />
                </SelectTrigger>
                <SelectContent>
                  {trips.map(trip => (
                    <SelectItem key={trip.id} value={trip.id}>
                      {trip.trip_code || trip.id.slice(0, 8)} - {trip.pickup_address.slice(0, 30)}...
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Customer Selection */}
            <div className="space-y-2">
              <Label>Customer *</Label>
              <Select 
                value={newFeedback.customer_id} 
                onValueChange={(v) => setNewFeedback(prev => ({ ...prev, customer_id: v }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select customer..." />
                </SelectTrigger>
                <SelectContent>
                  {customers.map(c => (
                    <SelectItem key={c.user_id} value={c.user_id}>
                      {c.first_name || ''} {c.last_name || ''} {c.phone ? `(${c.phone})` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Driver Selection (optional) */}
            <div className="space-y-2">
              <Label>Driver (Optional)</Label>
              <Select 
                value={newFeedback.driver_id} 
                onValueChange={(v) => setNewFeedback(prev => ({ ...prev, driver_id: v }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select driver..." />
                </SelectTrigger>
                <SelectContent>
                  {drivers.map(d => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.first_name} {d.last_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Rating */}
            <div className="space-y-2">
              <Label>Rating</Label>
              <div className="flex items-center gap-1">
                {[1, 2, 3, 4, 5].map((star) => (
                  <button
                    key={star}
                    type="button"
                    onClick={() => setNewFeedback(prev => ({ ...prev, rating: star }))}
                    className="p-1 hover:scale-110 transition-transform"
                  >
                    <Star
                      className={`h-8 w-8 ${
                        star <= newFeedback.rating 
                          ? 'fill-yellow-400 text-yellow-400' 
                          : 'text-muted-foreground/30 hover:text-yellow-300'
                      }`}
                    />
                  </button>
                ))}
                <span className="ml-2 text-lg font-medium">{newFeedback.rating}/5</span>
              </div>
            </div>

            {/* Feedback Type */}
            <div className="space-y-2">
              <Label>Feedback Type</Label>
              <Select 
                value={newFeedback.feedback_type} 
                onValueChange={(v) => setNewFeedback(prev => ({ ...prev, feedback_type: v }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TYPE_OPTIONS.map(opt => (
                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Comment */}
            <div className="space-y-2">
              <Label>Comment</Label>
              <Textarea
                placeholder="Customer's feedback or comment..."
                value={newFeedback.comment}
                onChange={(e) => setNewFeedback(prev => ({ ...prev, comment: e.target.value }))}
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsCreateDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreateFeedback} disabled={isCreating}>
              {isCreating && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Submit Feedback
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
}
