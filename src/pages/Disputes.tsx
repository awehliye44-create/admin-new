import { useState } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { supabase } from '@/integrations/supabase/client';
import { useQuery } from '@tanstack/react-query';
import { 
  Scale, 
  Search, 
  Download, 
  Eye,
  RefreshCw,
  Clock,
  CheckCircle2,
  AlertTriangle,
  MessageSquare,
  Info
} from 'lucide-react';

// This page shows rider feedback that could be treated as disputes
// Since there's no dedicated disputes table, we use rider_feedback with low ratings

interface DisputeItem {
  id: string;
  type: 'low_rating' | 'complaint';
  trip_id: string | null;
  customer_id: string;
  driver_id: string | null;
  driver_name: string | null;
  rating: number;
  comment: string | null;
  status: string | null;
  feedback_type: string | null;
  created_at: string;
  admin_notes: string | null;
}

export default function Disputes() {
  const [activeTab, setActiveTab] = useState('pending');
  const [searchTerm, setSearchTerm] = useState('');

  // Fetch rider feedback with low ratings as potential disputes
  const { data: disputes = [], isLoading, refetch } = useQuery({
    queryKey: ['disputes-feedback'],
    queryFn: async () => {
      const { data: feedback, error } = await supabase
        .from('rider_feedback')
        .select(`
          id,
          trip_id,
          customer_id,
          driver_id,
          rating,
          comment,
          status,
          feedback_type,
          created_at,
          admin_notes
        `)
        .order('created_at', { ascending: false })
        .limit(100);
      
      if (error) throw error;

      // Get driver names
      const driverIds = [...new Set(feedback?.filter(f => f.driver_id).map(f => f.driver_id) || [])];
      let driversMap: Record<string, string> = {};
      
      if (driverIds.length > 0) {
        const { data: drivers } = await supabase
          .from('drivers')
          .select('id, first_name, last_name')
          .in('id', driverIds);
        
        driversMap = (drivers || []).reduce((acc, d) => {
          acc[d.id] = `${d.first_name} ${d.last_name}`;
          return acc;
        }, {} as Record<string, string>);
      }

      return (feedback || []).map(f => ({
        id: f.id,
        type: (f.rating <= 2 ? 'low_rating' : 'complaint') as 'low_rating' | 'complaint',
        trip_id: f.trip_id,
        customer_id: f.customer_id,
        driver_id: f.driver_id,
        driver_name: f.driver_id ? driversMap[f.driver_id] || 'Unknown' : null,
        rating: f.rating,
        comment: f.comment,
        status: f.status || 'pending',
        feedback_type: f.feedback_type,
        created_at: f.created_at,
        admin_notes: f.admin_notes,
      }));
    },
  });

  const getStatusBadge = (status: string) => {
    const config: Record<string, { variant: 'default' | 'secondary' | 'destructive' | 'outline', icon: React.ReactNode, className?: string }> = {
      pending: { variant: 'secondary', icon: <Clock className="h-3 w-3 mr-1" /> },
      new: { variant: 'secondary', icon: <Clock className="h-3 w-3 mr-1" /> },
      investigating: { variant: 'outline', icon: <Search className="h-3 w-3 mr-1" /> },
      resolved: { variant: 'default', icon: <CheckCircle2 className="h-3 w-3 mr-1" />, className: 'bg-green-500' },
      reviewed: { variant: 'default', icon: <CheckCircle2 className="h-3 w-3 mr-1" />, className: 'bg-green-500' },
    };
    const { variant, icon, className } = config[status] || { variant: 'outline', icon: null };
    return (
      <Badge variant={variant} className={`flex items-center w-fit ${className || ''}`}>
        {icon}
        {status}
      </Badge>
    );
  };

  const getRatingBadge = (rating: number) => {
    if (rating <= 2) {
      return <Badge variant="destructive" className="flex items-center gap-1">⭐ {rating}</Badge>;
    }
    if (rating <= 3) {
      return <Badge variant="outline" className="border-amber-500 text-amber-500 flex items-center gap-1">⭐ {rating}</Badge>;
    }
    return <Badge variant="outline" className="flex items-center gap-1">⭐ {rating}</Badge>;
  };

  const filteredDisputes = disputes.filter(dispute => {
    const matchesSearch = 
      dispute.comment?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      dispute.driver_name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      dispute.id.toLowerCase().includes(searchTerm.toLowerCase());
    
    if (activeTab === 'pending') {
      return matchesSearch && (dispute.status === 'pending' || dispute.status === 'new');
    }
    if (activeTab === 'low_rating') {
      return matchesSearch && dispute.rating <= 2;
    }
    if (activeTab === 'resolved') {
      return matchesSearch && (dispute.status === 'resolved' || dispute.status === 'reviewed');
    }
    return matchesSearch;
  });

  // Stats
  const pendingCount = disputes.filter(d => d.status === 'pending' || d.status === 'new').length;
  const lowRatingCount = disputes.filter(d => d.rating <= 2).length;
  const resolvedCount = disputes.filter(d => d.status === 'resolved' || d.status === 'reviewed').length;
  const avgRating = disputes.length > 0 
    ? (disputes.reduce((sum, d) => sum + d.rating, 0) / disputes.length).toFixed(1)
    : 'N/A';

  if (isLoading) {
    return (
      <AdminLayout title="Disputes & Adjustments" description="Manage disputes">
        <div className="flex items-center justify-center h-64">
          <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout 
      title="Disputes & Adjustments" 
      description="Review rider feedback and handle disputes"
    >
      <div className="space-y-6">
        {/* Info banner */}
        <Card className="border-blue-500/50 bg-blue-500/5">
          <CardContent className="flex items-center gap-3 py-4">
            <Info className="h-5 w-5 text-blue-500" />
            <p className="text-sm text-muted-foreground">
              This page shows rider feedback from the database. Low ratings (≤2 stars) are highlighted as potential disputes.
            </p>
          </CardContent>
        </Card>

        {/* Stats */}
        <div className="grid gap-4 md:grid-cols-4">
          <Card className="border-amber-500/50">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Pending Review</CardTitle>
              <Clock className="h-4 w-4 text-amber-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-amber-500">{pendingCount}</div>
              <p className="text-xs text-muted-foreground">Awaiting review</p>
            </CardContent>
          </Card>
          <Card className="border-red-500/50">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Low Ratings</CardTitle>
              <AlertTriangle className="h-4 w-4 text-red-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-red-500">{lowRatingCount}</div>
              <p className="text-xs text-muted-foreground">≤2 stars</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Resolved</CardTitle>
              <CheckCircle2 className="h-4 w-4 text-green-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-500">{resolvedCount}</div>
              <p className="text-xs text-muted-foreground">Reviewed feedback</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Average Rating</CardTitle>
              <MessageSquare className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{avgRating} ⭐</div>
              <p className="text-xs text-muted-foreground">From {disputes.length} feedback</p>
            </CardContent>
          </Card>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
          <div className="flex flex-col sm:flex-row justify-between gap-4">
            <TabsList>
              <TabsTrigger value="pending" className="flex items-center gap-1">
                Pending
                {pendingCount > 0 && (
                  <Badge variant="secondary" className="ml-1 h-5 w-5 rounded-full p-0 flex items-center justify-center text-xs">
                    {pendingCount}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="low_rating" className="flex items-center gap-1">
                Low Ratings
                {lowRatingCount > 0 && (
                  <Badge variant="destructive" className="ml-1 h-5 w-5 rounded-full p-0 flex items-center justify-center text-xs">
                    {lowRatingCount}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="resolved">Resolved</TabsTrigger>
              <TabsTrigger value="all">All ({disputes.length})</TabsTrigger>
            </TabsList>

            <div className="flex gap-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input 
                  placeholder="Search..." 
                  className="pl-9 w-[200px]"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
              </div>
              <Button variant="outline" size="icon" onClick={() => refetch()}>
                <RefreshCw className="h-4 w-4" />
              </Button>
              <Button variant="outline">
                <Download className="h-4 w-4 mr-2" />
                Export
              </Button>
            </div>
          </div>

          <TabsContent value={activeTab} className="m-0">
            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>ID</TableHead>
                      <TableHead>Rating</TableHead>
                      <TableHead>Driver</TableHead>
                      <TableHead>Comment</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredDisputes.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                          No feedback found
                        </TableCell>
                      </TableRow>
                    ) : (
                      filteredDisputes.map((dispute) => (
                        <TableRow key={dispute.id}>
                          <TableCell className="font-mono text-sm">{dispute.id.substring(0, 8)}...</TableCell>
                          <TableCell>{getRatingBadge(dispute.rating)}</TableCell>
                          <TableCell>
                            <p className="font-medium">{dispute.driver_name || 'N/A'}</p>
                          </TableCell>
                          <TableCell>
                            <p className="text-sm truncate max-w-[250px]">
                              {dispute.comment || 'No comment provided'}
                            </p>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">{dispute.feedback_type || 'trip'}</Badge>
                          </TableCell>
                          <TableCell>{getStatusBadge(dispute.status || 'pending')}</TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {new Date(dispute.created_at).toLocaleDateString()}
                          </TableCell>
                          <TableCell className="text-right">
                            <Button variant="ghost" size="sm">
                              <Eye className="h-4 w-4" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </AdminLayout>
  );
}
