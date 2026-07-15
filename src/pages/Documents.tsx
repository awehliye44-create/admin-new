import { useState, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSignedUrl } from '@/hooks/useDriverFileUrl';
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
  Calendar, ExternalLink, ImageOff
} from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { useDocumentTypes } from '@/hooks/useDocumentTypes';
import {
  formatExpiryDisplayDate,
  getDocumentExpiryDisplayStatus,
  isDocumentExpiringSoon,
} from '@/lib/driverDocumentCompliance';

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
  is_current: boolean;
  superseded_by: string | null;
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
  const [includeSuperseded, setIncludeSuperseded] = useState(false);


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
      const isReReject = selectedDocument.status === 'approved' && reviewStatus === 'rejected';

      const updatePayload: Record<string, any> = {
        status: reviewStatus,
        rejection_reason: reviewStatus === 'rejected' ? rejectionReason.trim() : null,
        reviewed_at: new Date().toISOString(),
      };

      // On re-rejection, clear the file so the driver must re-upload
      if (isReReject) {
        updatePayload.file_url = null;
      }

      const { error } = await supabase
        .from('documents')
        .update(updatePayload as any)
        .eq('id', selectedDocument.id);

      if (error) throw error;

      toast.success(
        isReReject
          ? 'Document re-rejected — driver will be prompted to re-upload'
          : `Document ${reviewStatus === 'approved' ? 'approved' : 'rejected'} successfully`
      );
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

  const DOCUMENT_EXPIRY_WARNING_DAYS = 30;

  const getExpiryBadge = (doc: Document) => {
    if (!doc.expiry_date) return { expired: false, expiringSoon: false };
    const displayStatus = getDocumentExpiryDisplayStatus({
      status: doc.status,
      expiry_date: doc.expiry_date,
      has_expiry: true,
      warningDays: DOCUMENT_EXPIRY_WARNING_DAYS,
    });
    return {
      expired: displayStatus === 'expired',
      expiringSoon: displayStatus === 'expiring_soon',
    };
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
  const expiringCount = documents.filter((d) => getExpiryBadge(d).expiringSoon).length;

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
                    const { expired, expiringSoon } = getExpiryBadge(doc);
                    
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
                              {formatExpiryDisplayDate(doc.expiry_date)}
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
                              {doc.status === 'approved' && (
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
                                  Re-reject &amp; Request Re-upload
                                </DropdownMenuItem>
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
          <DocumentViewDialog 
            document={selectedDocument}
            onClose={() => setIsViewOpen(false)}
            getDocumentTypeLabel={getDocumentTypeLabel}
          />
        </Dialog>

        {/* Review Dialog */}
        <Dialog open={isReviewOpen} onOpenChange={setIsReviewOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {reviewStatus === 'approved' 
                  ? 'Approve Document' 
                  : selectedDocument?.status === 'approved' 
                    ? 'Re-reject Document' 
                    : 'Reject Document'}
              </DialogTitle>
              <DialogDescription>
                {selectedDocument?.document_name} - {selectedDocument?.driver?.first_name} {selectedDocument?.driver?.last_name}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              {reviewStatus === 'rejected' && (
                <div className="space-y-3">
                  {selectedDocument?.status === 'approved' && (
                    <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                      <strong>Re-rejection:</strong> The uploaded file will be cleared and the driver will be prompted to re-upload this document in their app.
                    </div>
                  )}
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

/** Sub-component for document view dialog — uses useSignedUrl hook */
function DocumentViewDialog({
  document: doc,
  onClose,
  getDocumentTypeLabel,
}: {
  document: Document | null;
  onClose: () => void;
  getDocumentTypeLabel: (type: string) => string;
}) {
  const { signedUrl, isLoading: isLoadingUrl, error: urlError } = useSignedUrl(doc?.file_url);

  if (!doc) return null;

  const isImage = doc.file_url && /\.(jpg|jpeg|png|gif|webp)$/i.test(doc.file_url);

  return (
    <DialogContent className="max-w-lg">
      <DialogHeader>
        <DialogTitle>Document Details</DialogTitle>
        <DialogDescription>{doc.document_name}</DialogDescription>
      </DialogHeader>
      <div className="space-y-4">
        {/* Document Preview */}
        {doc.file_url && (
          <div className="border rounded-lg overflow-hidden bg-muted/30">
            {isLoadingUrl ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                <span className="ml-2 text-sm text-muted-foreground">Loading document...</span>
              </div>
            ) : urlError ? (
              <div className="flex flex-col items-center justify-center py-8 gap-2">
                <ImageOff className="h-8 w-8 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">{urlError}</p>
              </div>
            ) : isImage && signedUrl ? (
              <img
                src={signedUrl}
                alt={doc.document_name}
                className="w-full max-h-[300px] object-contain"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                  (e.target as HTMLImageElement).parentElement!.innerHTML = `
                    <div class="flex flex-col items-center justify-center py-8 gap-2">
                      <p class="text-sm text-muted-foreground">Document file could not be loaded</p>
                    </div>`;
                }}
              />
            ) : signedUrl ? (
              <div className="flex items-center justify-center py-8">
                <FileText className="h-12 w-12 text-muted-foreground" />
              </div>
            ) : null}
          </div>
        )}

        {!doc.file_url && (
          <div className="flex flex-col items-center justify-center py-8 gap-2 border rounded-lg bg-muted/30">
            <ImageOff className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">No file attached to this document</p>
          </div>
        )}

        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label className="text-muted-foreground">Status</Label>
            <div className="mt-1">
              {(() => {
                const config = STATUS_CONFIG[doc.status] || STATUS_CONFIG.pending;
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
            <p className="font-medium">{getDocumentTypeLabel(doc.document_type)}</p>
          </div>
        </div>

        <div>
          <Label className="text-muted-foreground">Driver</Label>
          <p className="font-medium">
            {doc.driver
              ? `${doc.driver.first_name} ${doc.driver.last_name}`
              : 'Unknown'}
          </p>
          <p className="text-sm text-muted-foreground">{doc.driver?.phone}</p>
        </div>

        {doc.expiry_date && (
          <div>
            <Label className="text-muted-foreground">Expiry Date</Label>
            <p className="font-medium">{formatExpiryDisplayDate(doc.expiry_date)}</p>
          </div>
        )}

        {doc.notes && (
          <div>
            <Label className="text-muted-foreground">Notes</Label>
            <p className="text-sm bg-muted p-2 rounded">{doc.notes}</p>
          </div>
        )}

        {doc.rejection_reason && (
          <div>
            <Label className="text-muted-foreground text-red-600">Rejection Reason</Label>
            <p className="text-sm bg-red-50 text-red-700 p-2 rounded">{doc.rejection_reason}</p>
          </div>
        )}

        {doc.reviewed_at && (
          <div>
            <Label className="text-muted-foreground">Reviewed</Label>
            <p className="text-sm">{format(new Date(doc.reviewed_at), 'PPP p')}</p>
          </div>
        )}

        <div>
          <Label className="text-muted-foreground">Uploaded</Label>
          <p className="text-sm">{format(new Date(doc.created_at), 'PPP p')}</p>
        </div>
      </div>
      <DialogFooter>
        {signedUrl && (
          <Button variant="outline" onClick={() => window.open(signedUrl, '_blank')}>
            <ExternalLink className="h-4 w-4 mr-2" />
            Open File
          </Button>
        )}
        <Button onClick={onClose}>Close</Button>
      </DialogFooter>
    </DialogContent>
  );
}
