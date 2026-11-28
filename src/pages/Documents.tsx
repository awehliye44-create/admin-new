import { useState, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSignedUrl } from '@/hooks/useDriverFileUrl';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { supabase } from '@/integrations/supabase/client';
import {
  adminLookupByIds,
  adminPageMutate,
  adminPageSelect,
} from '@/lib/adminPageGatedData';
import { 
  FileText, Loader2, Search, RefreshCw, MoreHorizontal, Eye, 
  CheckCircle2, XCircle, Clock, AlertTriangle, FileCheck, FileClock,
  Calendar, ExternalLink, ImageOff, Trash2
} from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { useDocumentTypes } from '@/hooks/useDocumentTypes';
import {
  DocumentReviewDialog,
  type DocumentReviewDecision,
} from '@/components/documents/DocumentReviewDialog';
import {
  formatExpiryDisplayDate,
  getDocumentExpiryDisplayStatus,
  isDocumentExpiringSoon,
} from '@/lib/driverDocumentCompliance';
import { Textarea } from '@/components/ui/textarea';
import {
  adminResolveDocumentVehicleLink,
  adminRetireDocument,
} from '@/lib/vehicleLifecycleAdmin';
import {
  groupDocumentsIntoVersionChains,
  versionLifecycleLabel,
  type DocumentVersionChain,
} from '@/lib/documentVersionChains';

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
  /** Mapped from DB reviewed_by — never written from this page. */
  reviewerId?: string | null;
  created_at: string;
  is_current: boolean;
  superseded_by: string | null;
  vehicle_id: string | null;
  ambiguity_review_required?: boolean | null;
  driver?: {
    id: string;
    first_name: string;
    last_name: string;
    phone: string;
    deleted_at: string | null;
  } | null;
  vehicle?: {
    id: string;
    make: string | null;
    model: string | null;
    year: number | null;
    license_plate: string | null;
    is_primary: boolean | null;
    is_trip_active: boolean | null;
    operational_status: string | null;
  } | null;
}

/** A document belongs to a removed driver when the driver row is soft-deleted or gone. */
function isDeletedDriverDocument(doc: Document): boolean {
  return !doc.driver || Boolean(doc.driver.deleted_at);
}

/** Resolve the storage object path inside the private driver-documents bucket. */
function extractDriverDocumentStoragePath(fileUrl: string | null | undefined): string | null {
  if (!fileUrl) return null;
  const patterns = [
    /\/storage\/v1\/object\/(?:public|sign)\/driver-documents\/(.+)/,
    /\/storage\/v1\/object\/driver-documents\/(.+)/,
  ];
  for (const pattern of patterns) {
    const match = fileUrl.match(pattern);
    if (match?.[1]) return decodeURIComponent(match[1].split('?')[0]);
  }
  if (!fileUrl.startsWith('http')) return fileUrl;
  return null;
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
  const [selectedDocument, setSelectedDocument] = useState<Document | null>(null);
  const [reviewTarget, setReviewTarget] = useState<{ doc: Document; decision: DocumentReviewDecision } | null>(null);
  const [purgeTarget, setPurgeTarget] = useState<{ doc: Document; scope: 'document' | 'driver' } | null>(null);
  const [isPurging, setIsPurging] = useState(false);
  const [ambiguityTarget, setAmbiguityTarget] = useState<Document | null>(null);
  const [ambiguityVehicles, setAmbiguityVehicles] = useState<
    Array<{ id: string; make: string | null; model: string | null; year: number | null; license_plate: string | null }>
  >([]);
  const [ambiguityVehicleId, setAmbiguityVehicleId] = useState('');
  const [ambiguityBusy, setAmbiguityBusy] = useState(false);
  const [purgeReason, setPurgeReason] = useState('');
  const [retireTarget, setRetireTarget] = useState<Document | null>(null);
  const [retireReason, setRetireReason] = useState('');
  const [retireBusy, setRetireBusy] = useState(false);
  const [metaTarget, setMetaTarget] = useState<Document | null>(null);
  const [metaExpiry, setMetaExpiry] = useState('');
  const [metaNotes, setMetaNotes] = useState('');
  const [metaBusy, setMetaBusy] = useState(false);

  const { data: documents = [], isLoading } = useQuery({
    queryKey: ['documents-review', includeSuperseded],
    queryFn: async () => {
      // SSOT: default to current documents only. Superseded rows are historical.
      const filters = !includeSuperseded
        ? [{ op: 'eq' as const, col: 'is_current', val: true }]
        : [];
      const { rows } = await adminPageSelect<Record<string, unknown>>('documents', 'documents', {
        columns: [
          'id', 'driver_id', 'document_type', 'document_type_id', 'document_name', 'file_url',
          'status', 'expiry_date', 'notes', 'rejection_reason', 'reviewed_at', 'reviewed_by',
          'created_at', 'updated_at', 'is_current', 'superseded_by', 'last_reminded_at',
          'reminder_sent_days', 'submission_idempotency_key', 'vehicle_id',
          'ambiguity_review_required',
        ],
        filters,
        order: [
          { col: 'expiry_date', asc: true },
          { col: 'created_at', asc: false },
        ],
        limit: 500,
      });
      const driverIds = rows
        .map((r) => r.driver_id as string | null | undefined)
        .filter((id): id is string => Boolean(id));
      const vehicleIds = rows
        .map((r) => r.vehicle_id as string | null | undefined)
        .filter((id): id is string => Boolean(id));
      const [drivers, vehicles] = await Promise.all([
        adminLookupByIds<{
          id: string;
          first_name: string | null;
          last_name: string | null;
          phone: string | null;
          deleted_at: string | null;
        }>('documents', 'drivers', driverIds, [
          'id', 'first_name', 'last_name', 'phone', 'deleted_at',
        ]),
        adminLookupByIds<{
          id: string;
          make: string | null;
          model: string | null;
          year: number | null;
          license_plate: string | null;
          is_primary: boolean | null;
          is_trip_active: boolean | null;
          operational_status: string | null;
        }>('documents', 'vehicles', vehicleIds, [
          'id', 'make', 'model', 'year', 'license_plate', 'is_primary', 'is_trip_active',
          'operational_status',
        ]),
      ]);
      const byId = new Map(drivers.map((d) => [d.id, d]));
      const vehicleById = new Map(vehicles.map((v) => [v.id, v]));
      return rows.map((r) => {
        const reviewerRaw = r['reviewed_by'];
        return {
          ...r,
          reviewerId: typeof reviewerRaw === 'string' ? reviewerRaw : null,
          driver: r.driver_id ? byId.get(r.driver_id as string) ?? null : null,
          vehicle: r.vehicle_id ? vehicleById.get(r.vehicle_id as string) ?? null : null,
        };
      }) as Document[];
    },
    staleTime: 30_000,
  });

  const refreshData = () => queryClient.invalidateQueries({ queryKey: ['documents-review'] });

  /** Permanently erase document rows + their stored files (data-protection removal). */
  const handlePurge = async () => {
    if (!purgeTarget) return;
    if (!purgeReason.trim()) {
      toast.error('A reason is required for permanent deletion');
      return;
    }
    const { doc, scope } = purgeTarget;

    setIsPurging(true);
    try {
      const { rows } = await adminPageSelect<{ id: string; file_url: string | null }>(
        'documents',
        'documents',
        {
          columns: ['id', 'file_url'],
          filters: [
            scope === 'driver'
              ? { op: 'eq', col: 'driver_id', val: doc.driver_id }
              : { op: 'eq', col: 'id', val: doc.id },
          ],
          limit: 500,
        },
      );

      const targets = rows;
      const paths = targets
        .map((r) => extractDriverDocumentStoragePath(r.file_url))
        .filter((p): p is string => Boolean(p));

      if (paths.length > 0) {
        const { error: storageErr } = await supabase.storage.from('driver-documents').remove(paths);
        if (storageErr) throw storageErr;
      }

      await adminPageMutate('documents', 'documents', 'delete', {
        ids: targets.map((r) => r.id),
      });

      // Best-effort ops audit note via a no-op-safe mutate of notes is unavailable after delete;
      // reason is captured in the toast context for staff and required in the confirm UI.
      toast.success(
        scope === 'driver'
          ? `Deleted ${targets.length} document${targets.length === 1 ? '' : 's'} for this removed driver (${purgeReason.trim()})`
          : `Document permanently deleted (${purgeReason.trim()})`,
      );
      setPurgeTarget(null);
      setPurgeReason('');
      refreshData();
    } catch (err: any) {
      console.error('Error deleting documents:', err);
      toast.error(err.message || 'Failed to delete documents');
    } finally {
      setIsPurging(false);
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

  const filteredDocuments = useMemo(
    () =>
      documents.filter((doc) => {
        const matchesSearch =
          doc.document_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          doc.driver?.first_name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
          doc.driver?.last_name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
          (doc.vehicle?.license_plate ?? '').toLowerCase().includes(searchQuery.toLowerCase());

        const matchesStatus =
          statusFilter === 'all'
            ? true
            : statusFilter === 'ambiguous'
              ? Boolean(doc.ambiguity_review_required)
              : doc.status === statusFilter;
        const matchesType = typeFilter === 'all' || doc.document_type === typeFilter;

        return matchesSearch && matchesStatus && matchesType;
      }),
    [documents, searchQuery, statusFilter, typeFilter],
  );

  const documentChains: DocumentVersionChain[] = useMemo(
    () => groupDocumentsIntoVersionChains(filteredDocuments),
    [filteredDocuments],
  );

  const pendingCount = documents.filter(d => d.status === 'pending').length;
  const approvedCount = documents.filter(d => d.status === 'approved').length;
  const rejectedCount = documents.filter(d => d.status === 'rejected').length;
  const expiringCount = documents.filter((d) => getExpiryBadge(d).expiringSoon).length;
  const ambiguousCount = documents.filter((d) => d.ambiguity_review_required).length;

  const shortReviewer = (id: string | null | undefined) => {
    if (!id) return null;
    return id.length > 8 ? `${id.slice(0, 8)}…` : id;
  };

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
                Approve or reject driver-submitted documents. History groups versions by
                driver, document type, and vehicle (current vs retired).
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
                  <SelectItem value="ambiguous">
                    Ambiguous vehicle link{ambiguousCount > 0 ? ` (${ambiguousCount})` : ''}
                  </SelectItem>
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
              <Button
                variant={includeSuperseded ? 'default' : 'outline'}
                onClick={() => setIncludeSuperseded((v) => !v)}
                title="Toggle to include superseded/historical document rows"
              >
                {includeSuperseded ? 'Hiding history' : 'Show history'}
              </Button>
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
                    <TableHead>Driver / chain</TableHead>
                    <TableHead>Vehicle</TableHead>
                    <TableHead>Document Type</TableHead>
                    <TableHead>Version</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Dates / review</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {documentChains.map((chain) => {
                    const versionsToShow = includeSuperseded
                      ? chain.versions
                      : chain.versions.filter((v) => v.is_current !== false && !v.superseded_by);
                    const rows = versionsToShow.length > 0 ? versionsToShow : chain.versions.slice(0, 1);

                    return rows.map((raw, versionIndex) => {
                      const doc = raw as Document;
                      const statusConfig = STATUS_CONFIG[doc.status] || STATUS_CONFIG.pending;
                      const StatusIcon = statusConfig.icon;
                      const { expired, expiringSoon } = getExpiryBadge(doc);
                      const lifecycle = versionLifecycleLabel(doc);
                      const isFirstInChain = versionIndex === 0;

                      return (
                        <TableRow
                          key={doc.id}
                          className={
                            !isFirstInChain && includeSuperseded
                              ? 'bg-muted/30'
                              : undefined
                          }
                        >
                          <TableCell>
                            {isFirstInChain ? (
                              <>
                                <div className="font-medium">
                                  {doc.driver
                                    ? `${doc.driver.first_name} ${doc.driver.last_name}`
                                    : 'Unknown'}
                                </div>
                                <div className="text-xs text-muted-foreground">
                                  {doc.driver?.phone || 'No phone'}
                                </div>
                                {includeSuperseded && chain.versions.length > 1 ? (
                                  <div className="text-[10px] text-muted-foreground mt-1">
                                    {chain.versions.length} versions in chain
                                  </div>
                                ) : null}
                                {isDeletedDriverDocument(doc) && (
                                  <Badge variant="outline" className="mt-1 bg-zinc-100 text-zinc-700 text-xs">
                                    Removed driver
                                  </Badge>
                                )}
                                {doc.ambiguity_review_required && (
                                  <Badge variant="outline" className="mt-1 bg-amber-100 text-amber-800 text-xs">
                                    Ambiguous vehicle link
                                  </Badge>
                                )}
                              </>
                            ) : (
                              <span className="text-xs text-muted-foreground pl-3">↳ prior version</span>
                            )}
                          </TableCell>
                          <TableCell>
                            {isFirstInChain ? (
                              doc.vehicle ? (
                                <div>
                                  <div className="font-medium text-sm">
                                    {doc.vehicle.license_plate || '—'}
                                  </div>
                                  <div className="text-xs text-muted-foreground">
                                    {[doc.vehicle.year, doc.vehicle.make, doc.vehicle.model]
                                      .filter((v) => v != null && v !== '')
                                      .join(' ') || 'Vehicle'}
                                  </div>
                                  {doc.vehicle.is_trip_active ? (
                                    <Badge variant="outline" className="mt-1 text-xs bg-green-50 text-green-700">
                                      Trip active
                                    </Badge>
                                  ) : doc.vehicle.is_primary ? (
                                    <Badge variant="outline" className="mt-1 text-xs">
                                      Primary
                                    </Badge>
                                  ) : null}
                                </div>
                              ) : (
                                <span className="text-muted-foreground text-sm">Driver doc</span>
                              )
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell>
                            {isFirstInChain
                              ? getDocumentTypeLabel(doc.document_type)
                              : (
                                <span className="text-xs text-muted-foreground">
                                  {getDocumentTypeLabel(doc.document_type)}
                                </span>
                              )}
                          </TableCell>
                          <TableCell>
                            <div className="flex flex-col gap-1">
                              <Badge
                                variant="outline"
                                className={
                                  lifecycle === 'Current'
                                    ? 'bg-green-50 text-green-700 text-xs w-fit'
                                    : 'bg-zinc-100 text-zinc-700 text-xs w-fit'
                                }
                              >
                                {lifecycle}
                              </Badge>
                              <span className="text-xs font-medium truncate max-w-[140px]" title={doc.document_name}>
                                {doc.document_name}
                              </span>
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="flex flex-col gap-1">
                              <Badge variant="outline" className={statusConfig.color}>
                                <StatusIcon className="h-3 w-3 mr-1" />
                                {statusConfig.label}
                              </Badge>
                              {doc.rejection_reason ? (
                                <span className="text-[10px] text-destructive max-w-[160px] truncate" title={doc.rejection_reason}>
                                  Reason: {doc.rejection_reason}
                                </span>
                              ) : null}
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="text-xs space-y-1 text-muted-foreground">
                              <div>
                                Uploaded {format(new Date(doc.created_at), 'MMM d, yyyy')}
                              </div>
                              {doc.reviewed_at ? (
                                <div>
                                  Reviewed {format(new Date(doc.reviewed_at), 'MMM d, yyyy')}
                                  {doc.reviewerId ? (
                                    <span title={doc.reviewerId}>
                                      {' '}· {shortReviewer(doc.reviewerId)}
                                    </span>
                                  ) : null}
                                </div>
                              ) : null}
                              {doc.expiry_date ? (
                                <div className={`flex items-center gap-1 ${expired ? 'text-red-600' : expiringSoon ? 'text-orange-600' : ''}`}>
                                  <Calendar className="h-3 w-3" />
                                  Exp {formatExpiryDisplayDate(doc.expiry_date)}
                                  {expired && <Badge variant="destructive" className="ml-1 text-xs">Expired</Badge>}
                                  {expiringSoon && !expired && (
                                    <Badge variant="outline" className="ml-1 text-xs bg-orange-100 text-orange-700">Soon</Badge>
                                  )}
                                </div>
                              ) : null}
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
                                <DropdownMenuItem onClick={() => { setSelectedDocument(doc); setIsViewOpen(true); }}>
                                  <Eye className="h-4 w-4 mr-2" />
                                  View Details
                                </DropdownMenuItem>
                                {doc.ambiguity_review_required && !isDeletedDriverDocument(doc) ? (
                                  <DropdownMenuItem
                                    onClick={async () => {
                                      setAmbiguityTarget(doc);
                                      setAmbiguityVehicleId(doc.vehicle_id ?? '');
                                      try {
                                        const { rows } = await adminPageSelect<{
                                          id: string;
                                          make: string | null;
                                          model: string | null;
                                          year: number | null;
                                          license_plate: string | null;
                                        }>('documents', 'vehicles', {
                                          columns: ['id', 'make', 'model', 'year', 'license_plate'],
                                          filters: [{ op: 'eq', col: 'driver_id', val: doc.driver_id }],
                                          limit: 20,
                                        });
                                        setAmbiguityVehicles(rows);
                                      } catch {
                                        setAmbiguityVehicles([]);
                                        toast.error('Could not load this driver’s vehicles');
                                      }
                                    }}
                                  >
                                    <AlertTriangle className="h-4 w-4 mr-2" />
                                    Resolve vehicle link
                                  </DropdownMenuItem>
                                ) : null}
                                <DropdownMenuSeparator />
                                {!isDeletedDriverDocument(doc) && doc.status === 'pending' && (
                                  <>
                                    <DropdownMenuItem
                                      onClick={() => setReviewTarget({ doc, decision: 'approved' })}
                                      className="text-green-600"
                                    >
                                      <CheckCircle2 className="h-4 w-4 mr-2" />
                                      Approve
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      onClick={() => setReviewTarget({ doc, decision: 'rejected' })}
                                      className="text-red-600"
                                    >
                                      <XCircle className="h-4 w-4 mr-2" />
                                      Reject
                                    </DropdownMenuItem>
                                  </>
                                )}
                                {!isDeletedDriverDocument(doc) && doc.status === 'approved' && doc.is_current !== false && (
                                  <DropdownMenuItem
                                    onClick={() => setReviewTarget({ doc, decision: 'rejected' })}
                                    className="text-red-600"
                                  >
                                    <XCircle className="h-4 w-4 mr-2" />
                                    Re-reject &amp; Request Re-upload
                                  </DropdownMenuItem>
                                )}
                                {!isDeletedDriverDocument(doc) ? (
                                  <>
                                    <DropdownMenuItem
                                      onClick={() => {
                                        setMetaTarget(doc);
                                        setMetaExpiry(doc.expiry_date ?? '');
                                        setMetaNotes(doc.notes ?? '');
                                      }}
                                    >
                                      Edit metadata
                                    </DropdownMenuItem>
                                    {doc.is_current !== false ? (
                                      <DropdownMenuItem
                                        onClick={() => {
                                          setRetireTarget(doc);
                                          setRetireReason('');
                                        }}
                                        className="text-red-600"
                                      >
                                        <Trash2 className="h-4 w-4 mr-2" />
                                        Remove from active use
                                      </DropdownMenuItem>
                                    ) : null}
                                  </>
                                ) : null}
                                {isDeletedDriverDocument(doc) && (
                                  <>
                                    <DropdownMenuItem
                                      onClick={() => {
                                        setPurgeTarget({ doc, scope: 'document' });
                                        setPurgeReason('');
                                      }}
                                      className="text-red-600"
                                    >
                                      <Trash2 className="h-4 w-4 mr-2" />
                                      Delete this document
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      onClick={() => {
                                        setPurgeTarget({ doc, scope: 'driver' });
                                        setPurgeReason('');
                                      }}
                                      className="text-red-600"
                                    >
                                      <Trash2 className="h-4 w-4 mr-2" />
                                      Delete all documents for this driver
                                    </DropdownMenuItem>
                                  </>
                                )}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </TableCell>
                        </TableRow>
                      );
                    });
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

        {/* Review Dialog (shared with Driver Details) */}
        <DocumentReviewDialog
          open={Boolean(reviewTarget)}
          onOpenChange={(open) => { if (!open) setReviewTarget(null); }}
          document={reviewTarget?.doc ?? null}
          decision={reviewTarget?.decision ?? null}
          driverName={reviewTarget?.doc.driver
            ? `${reviewTarget.doc.driver.first_name} ${reviewTarget.doc.driver.last_name}`
            : undefined}
          pageSlug="documents"
        />

        <Dialog
          open={Boolean(ambiguityTarget)}
          onOpenChange={(open) => {
            if (!open) {
              setAmbiguityTarget(null);
              setAmbiguityVehicles([]);
              setAmbiguityVehicleId('');
            }
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Resolve vehicle document link</DialogTitle>
              <DialogDescription>
                This document could not be associated automatically. Choose the correct vehicle for{' '}
                {ambiguityTarget
                  ? getDocumentTypeLabel(ambiguityTarget.document_type)
                  : 'this document'}
                . Do not guess — only confirm when the match is certain.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label>Vehicle</Label>
              <Select value={ambiguityVehicleId} onValueChange={setAmbiguityVehicleId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select vehicle" />
                </SelectTrigger>
                <SelectContent>
                  {ambiguityVehicles.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      {v.license_plate || '—'} · {[v.year, v.make, v.model].filter(Boolean).join(' ')}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setAmbiguityTarget(null)}
                disabled={ambiguityBusy}
              >
                Cancel
              </Button>
              <Button
                disabled={ambiguityBusy || !ambiguityTarget || !ambiguityVehicleId}
                onClick={() => {
                  if (!ambiguityTarget) return;
                  setAmbiguityBusy(true);
                  void adminResolveDocumentVehicleLink(ambiguityTarget.id, ambiguityVehicleId)
                    .then((result) => {
                      if (result.ok) {
                        toast.success('Vehicle link resolved');
                        setAmbiguityTarget(null);
                        refreshData();
                      } else {
                        toast.error(result.message);
                      }
                    })
                    .finally(() => setAmbiguityBusy(false));
                }}
              >
                {ambiguityBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Confirm link'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Soft-retire: remove from active use, keep history */}
        <Dialog
          open={Boolean(retireTarget)}
          onOpenChange={(open) => {
            if (!open) setRetireTarget(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Remove document from active use?</DialogTitle>
              <DialogDescription>
                Marks this version as not current. The file and prior history stay available under
                Show history. Related trips and vehicle records are not deleted.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="retire-reason">Reason</Label>
              <Textarea
                id="retire-reason"
                value={retireReason}
                onChange={(e) => setRetireReason(e.target.value)}
                rows={3}
                placeholder="Required for the audit record"
              />
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setRetireTarget(null)}
                disabled={retireBusy}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={retireBusy || !retireReason.trim()}
                onClick={() => {
                  if (!retireTarget || !retireReason.trim()) return;
                  setRetireBusy(true);
                  void adminRetireDocument(retireTarget.id, retireReason.trim())
                    .then((result) => {
                      if (result.ok) {
                        toast.success(
                          typeof result.data.status_label === 'string'
                            ? result.data.status_label
                            : 'Document retired — history retained',
                        );
                        setRetireTarget(null);
                        setRetireReason('');
                        refreshData();
                      } else {
                        toast.error(result.message);
                      }
                    })
                    .finally(() => setRetireBusy(false));
                }}
              >
                {retireBusy ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                Remove from active use
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Metadata edit (expiry / notes) — linkage uses Resolve vehicle link */}
        <Dialog
          open={Boolean(metaTarget)}
          onOpenChange={(open) => {
            if (!open) setMetaTarget(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Edit document metadata</DialogTitle>
              <DialogDescription>
                Update permitted expiry and notes. Vehicle linkage for ambiguous rows uses Resolve
                vehicle link (ownership checked server-side).
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="meta-expiry">Expiry date</Label>
                <Input
                  id="meta-expiry"
                  type="date"
                  value={metaExpiry}
                  onChange={(e) => setMetaExpiry(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="meta-notes">Notes</Label>
                <Textarea
                  id="meta-notes"
                  value={metaNotes}
                  onChange={(e) => setMetaNotes(e.target.value)}
                  rows={3}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setMetaTarget(null)} disabled={metaBusy}>
                Cancel
              </Button>
              <Button
                disabled={metaBusy || !metaTarget}
                onClick={() => {
                  if (!metaTarget) return;
                  setMetaBusy(true);
                  void adminPageMutate('documents', 'documents', 'update', {
                    id: metaTarget.id,
                    patch: {
                      expiry_date: metaExpiry.trim() || null,
                      notes: metaNotes.trim() || null,
                    },
                  })
                    .then(() => {
                      toast.success('Document metadata updated');
                      setMetaTarget(null);
                      refreshData();
                    })
                    .catch((err: Error) => toast.error(err.message || 'Update failed'))
                    .finally(() => setMetaBusy(false));
                }}
              >
                {metaBusy ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                Save
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Permanent deletion (data protection) */}
        <Dialog
          open={Boolean(purgeTarget)}
          onOpenChange={(open) => {
            if (!open) {
              setPurgeTarget(null);
              setPurgeReason('');
            }
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {purgeTarget?.scope === 'driver'
                  ? 'Delete all documents for this removed driver?'
                  : 'Delete this document permanently?'}
              </DialogTitle>
              <DialogDescription>
                This driver has been removed from the platform. The document record and the uploaded
                file will be erased permanently. This cannot be undone. Prefer Remove from active use
                for live drivers so history is retained.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="purge-reason">Reason</Label>
              <Textarea
                id="purge-reason"
                value={purgeReason}
                onChange={(e) => setPurgeReason(e.target.value)}
                rows={2}
                placeholder="Required"
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setPurgeTarget(null)} disabled={isPurging}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => void handlePurge()}
                disabled={isPurging || !purgeReason.trim()}
              >
                {isPurging ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Trash2 className="h-4 w-4 mr-2" />}
                Delete permanently
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

        {doc.status === 'rejected' && doc.rejection_reason && (
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
