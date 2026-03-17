import { useState, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { supabase } from '@/integrations/supabase/client';
import { 
  FileText, Loader2, Search, RefreshCw, MoreHorizontal, Eye, 
  CheckCircle2, XCircle, Clock, AlertTriangle, FileCheck, FileClock,
  Calendar
} from 'lucide-react';
import { format, isPast, addDays, isBefore } from 'date-fns';
import { toast } from 'sonner';
import { useDocumentTypes } from '@/hooks/useDocumentTypes';

interface Document {
  id: string;
  driver_id: string;
  document_type: string;
  document_name: string;
  file_url: string | null;
  status: string;
  expiry_date: string | null;
  notes: string | null;
  rejection_reason: string | null;
  reviewed_at: string | null;
  created_at: string;
  driver?: {
    id: string;
    first_name: string;
    last_name: string;
    phone: string;
  } | null;
}

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: any }> = {
  pending: { label: 'Pending Review', color: 'bg-yellow-100 text-yellow-700', icon: Clock },
  approved: { label: 'Approved', color: 'bg-green-100 text-green-700', icon: CheckCircle2 },
  rejected: { label: 'Rejected', color: 'bg-red-100 text-red-700', icon: XCircle },
  expired: { label: 'Expired', color: 'bg-gray-100 text-gray-700', icon: AlertTriangle },
};

export default function Documents() {
  const queryClient = useQueryClient();
  const { data: dbDocTypes } = useDocumentTypes();
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');

  // Only show active document types for filtering
  const DOCUMENT_TYPES = useMemo(() =>
    (dbDocTypes || []).filter(dt => dt.is_active).map(dt => ({
      value: dt.slug,
      label: dt.name,
    })),
    [dbDocTypes]
  );

  // Dialog states
  const [isViewOpen, setIsViewOpen] = useState(false);
  const [isReviewOpen, setIsReviewOpen] = useState(false);
  const [selectedDocument, setSelectedDocument] = useState<Document | null>(null);
  const [reviewStatus, setReviewStatus] = useState('');
  const [rejectionReason, setRejectionReason] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const { data: documents = [], isLoading } = useQuery({
    queryKey: ['documents-review'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('documents')
        .select(`
          *,
          driver:drivers(id, first_name, last_name, phone)
        `)
        .order('created_at', { ascending: false });

      if (error) throw error;
      return (data || []) as Document[];
    },
    staleTime: 30_000,
  });

  const refreshData = () => queryClient.invalidateQueries({ queryKey: ['documents-review'] });

  const handleReview = async () => {
    if (!selectedDocument || !reviewStatus) {
      toast.error('Please select a status');
      return;
    }

    if (reviewStatus === 'rejected' && !rejectionReason.trim()) {
      toast.error('Please provide a rejection reason');
      return;
    }

    setIsSaving(true);
    try {
      const { error } = await supabase
        .from('documents')
        .update({
          status: reviewStatus,
          rejection_reason: reviewStatus === 'rejected' ? rejectionReason.trim() : null,
          reviewed_at: new Date().toISOString(),
        })
        .eq('id', selectedDocument.id);

      if (error) throw error;

      toast.success(`Document ${reviewStatus === 'approved' ? 'approved' : 'rejected'} successfully`);
      setIsReviewOpen(false);
      setSelectedDocument(null);
      setReviewStatus('');
      setRejectionReason('');
      refreshData();
    } catch (err: any) {
      console.error('Error reviewing document:', err);
      toast.error(err.message || 'Failed to review document');
    } finally {
      setIsSaving(false);
    }
  };

  const getDocumentTypeLabel = (type: string) => {
    return DOCUMENT_TYPES.find(t => t.value === type)?.label || type;
  };

  const isExpiringSoon = (expiryDate: string | null) => {
    if (!expiryDate) return false;
    const expiry = new Date(expiryDate);
    const warningDate = addDays(new Date(), 30);
    return isBefore(expiry, warningDate) && !isPast(expiry);
  };

  const filteredDocuments = documents.filter(doc => {
    const matchesSearch = 
      doc.document_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      doc.driver?.first_name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      doc.driver?.last_name?.toLowerCase().includes(searchQuery.toLowerCase());
    
    const matchesStatus = statusFilter === 'all' || doc.status === statusFilter;
    const matchesType = typeFilter === 'all' || doc.document_type === typeFilter;
    
    return matchesSearch && matchesStatus && matchesType;
  });

  const pendingCount = documents.filter(d => d.status === 'pending').length;
  const approvedCount = documents.filter(d => d.status === 'approved').length;
  const rejectedCount = documents.filter(d => d.status === 'rejected').length;
  const expiringCount = documents.filter(d => d.expiry_date && isExpiringSoon(d.expiry_date)).length;

  return (
    <AdminLayout 
      title="Document Review" 
      description="Review and approve driver-uploaded documents. Document configuration is managed in Document Management."
    >
      <div className="space-y-6">
        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Total Documents</p>
                  <p className="text-2xl font-bold">{documents.length}</p>
                </div>
                <FileText className="h-8 w-8 text-primary opacity-80" />
              </div>
            </CardContent>
          </Card>
          <Card className="border-yellow-500/30 bg-yellow-500/5">
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Pending Review</p>
                  <p className="text-2xl font-bold text-yellow-600">{pendingCount}</p>
                </div>
                <FileClock className="h-8 w-8 text-yellow-500" />
              </div>
            </CardContent>
          </Card>
          <Card className="border-green-500/30 bg-green-500/5">
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Approved</p>
                  <p className="text-2xl font-bold text-green-600">{approvedCount}</p>
                </div>
                <FileCheck className="h-8 w-8 text-green-500" />
              </div>
            </CardContent>
          </Card>
          <Card className="border-orange-500/30 bg-orange-500/5">
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Expiring Soon</p>
                  <p className="text-2xl font-bold text-orange-600">{expiringCount}</p>
                </div>
                <AlertTriangle className="h-8 w-8 text-orange-500" />
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Documents Table */}
        <Card>
          <CardHeader className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <FileText className="h-5 w-5 text-primary" />
                Uploaded Documents
              </CardTitle>
              <CardDescription>
                Approve or reject driver-submitted documents
              </CardDescription>
            </div>
            <div className="flex flex-col gap-2 md:flex-row md:items-center">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search documents..."
                  className="pl-9 w-full md:w-[180px]"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-full md:w-[140px]">
                  <SelectValue placeholder="All Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Status</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="approved">Approved</SelectItem>
                  <SelectItem value="rejected">Rejected</SelectItem>
                </SelectContent>
              </Select>
              <Select value={typeFilter} onValueChange={setTypeFilter}>
                <SelectTrigger className="w-full md:w-[160px]">
                  <SelectValue placeholder="All Types" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  {DOCUMENT_TYPES.map(type => (
                    <SelectItem key={type.value} value={type.value}>{type.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button variant="outline" onClick={refreshData} disabled={isLoading}>
                <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
                Refresh
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
              </div>
            ) : filteredDocuments.length === 0 ? (
              <div className="py-12 text-center">
                <FileText className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                <h3 className="text-lg font-medium mb-2">No documents found</h3>
                <p className="text-muted-foreground">
                  {searchQuery || statusFilter !== 'all' || typeFilter !== 'all'
                    ? 'Try adjusting your filters' 
                    : 'No documents have been uploaded yet'}
                </p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Driver</TableHead>
                    <TableHead>Document Type</TableHead>
                    <TableHead>Document Name</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Expiry Date</TableHead>
                    <TableHead>Uploaded</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredDocuments.map((doc) => {
                    const statusConfig = STATUS_CONFIG[doc.status] || STATUS_CONFIG.pending;
                    const StatusIcon = statusConfig.icon;
                    const expiringSoon = isExpiringSoon(doc.expiry_date);
                    const expired = doc.expiry_date && isPast(new Date(doc.expiry_date));
                    
                    return (
                      <TableRow key={doc.id}>
                        <TableCell>
                          <div className="font-medium">
                            {doc.driver ? `${doc.driver.first_name} ${doc.driver.last_name}` : 'Unknown'}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {doc.driver?.phone || 'No phone'}
                          </div>
                        </TableCell>
                        <TableCell>{getDocumentTypeLabel(doc.document_type)}</TableCell>
                        <TableCell className="font-medium">{doc.document_name}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className={statusConfig.color}>
                            <StatusIcon className="h-3 w-3 mr-1" />
                            {statusConfig.label}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {doc.expiry_date ? (
                            <div className={`flex items-center gap-1 ${expired ? 'text-red-600' : expiringSoon ? 'text-orange-600' : ''}`}>
                              <Calendar className="h-3 w-3" />
                              {format(new Date(doc.expiry_date), 'MMM d, yyyy')}
                              {expired && <Badge variant="destructive" className="ml-1 text-xs">Expired</Badge>}
                              {expiringSoon && !expired && <Badge variant="outline" className="ml-1 text-xs bg-orange-100 text-orange-700">Soon</Badge>}
                            </div>
                          ) : (
                            <span className="text-muted-foreground">N/A</span>
                          )}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {format(new Date(doc.created_at), 'MMM d, yyyy')}
                        </TableCell>
                        <TableCell className="text-right">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon">
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => { setSelectedDocument(doc); setIsViewOpen(true); }}>
                                <Eye className="h-4 w-4 mr-2" />
                                View Details
                              </DropdownMenuItem>
                              {doc.file_url && (
                                <DropdownMenuItem onClick={() => window.open(doc.file_url!, '_blank')}>
                                  <FileText className="h-4 w-4 mr-2" />
                                  View File
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuSeparator />
                              {doc.status === 'pending' && (
                                <>
                                  <DropdownMenuItem 
                                    onClick={() => { 
                                      setSelectedDocument(doc); 
                                      setReviewStatus('approved'); 
                                      setRejectionReason('');
                                      setIsReviewOpen(true); 
                                    }}
                                    className="text-green-600"
                                  >
                                    <CheckCircle2 className="h-4 w-4 mr-2" />
                                    Approve
                                  </DropdownMenuItem>
                                  <DropdownMenuItem 
                                    onClick={() => { 
                                      setSelectedDocument(doc); 
                                      setReviewStatus('rejected'); 
                                      setRejectionReason('');
                                      setIsReviewOpen(true); 
                                    }}
                                    className="text-red-600"
                                  >
                                    <XCircle className="h-4 w-4 mr-2" />
                                    Reject
                                  </DropdownMenuItem>
                                </>
                              )}
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

        {/* View Details Dialog */}
        <Dialog open={isViewOpen} onOpenChange={setIsViewOpen}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Document Details</DialogTitle>
              <DialogDescription>
                {selectedDocument?.document_name}
              </DialogDescription>
            </DialogHeader>
            {selectedDocument && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label className="text-muted-foreground">Status</Label>
                    <div className="mt-1">
                      {(() => {
                        const config = STATUS_CONFIG[selectedDocument.status] || STATUS_CONFIG.pending;
                        const Icon = config.icon;
                        return (
                          <Badge variant="outline" className={config.color}>
                            <Icon className="h-3 w-3 mr-1" />
                            {config.label}
                          </Badge>
                        );
                      })()}
                    </div>
                  </div>
                  <div>
                    <Label className="text-muted-foreground">Document Type</Label>
                    <p className="font-medium">{getDocumentTypeLabel(selectedDocument.document_type)}</p>
                  </div>
                </div>

                <div>
                  <Label className="text-muted-foreground">Driver</Label>
                  <p className="font-medium">
                    {selectedDocument.driver 
                      ? `${selectedDocument.driver.first_name} ${selectedDocument.driver.last_name}`
                      : 'Unknown'}
                  </p>
                  <p className="text-sm text-muted-foreground">{selectedDocument.driver?.phone}</p>
                </div>

                {selectedDocument.expiry_date && (
                  <div>
                    <Label className="text-muted-foreground">Expiry Date</Label>
                    <p className="font-medium">{format(new Date(selectedDocument.expiry_date), 'PPP')}</p>
                  </div>
                )}

                {selectedDocument.notes && (
                  <div>
                    <Label className="text-muted-foreground">Notes</Label>
                    <p className="text-sm bg-muted p-2 rounded">{selectedDocument.notes}</p>
                  </div>
                )}

                {selectedDocument.rejection_reason && (
                  <div>
                    <Label className="text-muted-foreground text-red-600">Rejection Reason</Label>
                    <p className="text-sm bg-red-50 text-red-700 p-2 rounded">{selectedDocument.rejection_reason}</p>
                  </div>
                )}

                {selectedDocument.reviewed_at && (
                  <div>
                    <Label className="text-muted-foreground">Reviewed</Label>
                    <p className="text-sm">{format(new Date(selectedDocument.reviewed_at), 'PPP p')}</p>
                  </div>
                )}

                <div>
                  <Label className="text-muted-foreground">Uploaded</Label>
                  <p className="text-sm">{format(new Date(selectedDocument.created_at), 'PPP p')}</p>
                </div>
              </div>
            )}
            <DialogFooter>
              {selectedDocument?.file_url && (
                <Button variant="outline" onClick={() => window.open(selectedDocument.file_url!, '_blank')}>
                  View File
                </Button>
              )}
              <Button onClick={() => setIsViewOpen(false)}>Close</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Review Dialog */}
        <Dialog open={isReviewOpen} onOpenChange={setIsReviewOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {reviewStatus === 'approved' ? 'Approve Document' : 'Reject Document'}
              </DialogTitle>
              <DialogDescription>
                {selectedDocument?.document_name} - {selectedDocument?.driver?.first_name} {selectedDocument?.driver?.last_name}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              {reviewStatus === 'rejected' && (
                <div>
                  <Label htmlFor="rejectionReason">Rejection Reason *</Label>
                  <Textarea
                    id="rejectionReason"
                    value={rejectionReason}
                    onChange={(e) => setRejectionReason(e.target.value)}
                    placeholder="Please provide a reason for rejection..."
                    rows={3}
                  />
                </div>
              )}
              {reviewStatus === 'approved' && (
                <p className="text-sm text-muted-foreground">
                  This will approve the document and mark it as verified.
                </p>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setIsReviewOpen(false)}>Cancel</Button>
              <Button 
                onClick={handleReview} 
                disabled={isSaving}
                variant={reviewStatus === 'rejected' ? 'destructive' : 'default'}
              >
                {isSaving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                {reviewStatus === 'approved' ? 'Approve' : 'Reject'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </AdminLayout>
  );
}
