import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { supabase } from '@/integrations/supabase/client';
import { getSignedDocumentUrl } from '@/hooks/useDriverFileUrl';
import {
  approvalReadiness,
  changedVehicleFields,
  formatVehicle,
  parseVehicleChangeReview,
  vehicleChangeDecisionMessage,
  type ReviewDocument,
  type VehicleChangeReview,
  type VehicleDetails,
} from '@/lib/vehicleChangeReview';
import { AlertTriangle, CheckCircle, ExternalLink, Loader2, XCircle } from 'lucide-react';
import { toast } from 'sonner';

type Props = {
  requestId: string | null;
  driverLabel: string;
  onClose: () => void;
  onDecided: (decision: 'approve' | 'reject') => void;
};

const FIELD_LABELS: Record<keyof VehicleDetails, string> = {
  make: 'Make',
  model: 'Model',
  year: 'Year',
  colour: 'Colour',
  licence_plate: 'Registration',
};

const DOC_STATE_STYLES: Record<ReviewDocument['state'], string> = {
  approved: 'bg-green-500/10 text-green-700',
  pending: 'bg-yellow-500/15 text-yellow-700',
  missing: 'bg-destructive/10 text-destructive',
  expired: 'bg-destructive/10 text-destructive',
  rejected: 'bg-destructive/10 text-destructive',
};

export function VehicleChangeReviewDialog({ requestId, driverLabel, onClose, onDecided }: Props) {
  const [review, setReview] = useState<VehicleChangeReview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [reviewedDocs, setReviewedDocs] = useState<Set<string>>(new Set());
  const [enabledCategories, setEnabledCategories] = useState<Set<string>>(new Set());
  const [rejectionReason, setRejectionReason] = useState('');
  const [adminNotes, setAdminNotes] = useState('');
  const [submitting, setSubmitting] = useState<'approve' | 'reject' | null>(null);
  const [openingDoc, setOpeningDoc] = useState<string | null>(null);

  const load = useCallback(async (id: string) => {
    setIsLoading(true);
    setLoadError(null);
    const { data, error } = await supabase.rpc('admin_get_vehicle_change_review', { p_request_id: id });
    const parsed = error ? null : parseVehicleChangeReview(data);
    if (!parsed) {
      const code = (data as { code?: string } | null)?.code;
      setReview(null);
      setLoadError(error ? 'Could not load this request.' : vehicleChangeDecisionMessage(code));
    } else {
      setReview(parsed);
      setReviewedDocs(new Set());
      setEnabledCategories(
        new Set(parsed.categories.filter((c) => c.enabled).map((c) => c.vehicle_type_id)),
      );
    }
    setIsLoading(false);
  }, []);

  useEffect(() => {
    if (!requestId) {
      setReview(null);
      setLoadError(null);
      setRejectionReason('');
      setAdminNotes('');
      return;
    }
    void load(requestId);
  }, [requestId, load]);

  const changedFields = useMemo(() => (review ? changedVehicleFields(review) : []), [review]);
  const identityChanged = changedFields.some((f) => f === 'licence_plate' || f === 'make' || f === 'model');
  const vehicleDrifted = useMemo(() => {
    if (!review?.currentVehicle) return false;
    const cur = review.currentVehicle;
    const prev = review.request.previous;
    const plate = (v: string | null) => (v ?? '').replace(/\s+/g, '').toUpperCase();
    return (
      plate(cur.licence_plate) !== plate(prev.licence_plate) ||
      (cur.make ?? '') !== (prev.make ?? '') ||
      (cur.model ?? '') !== (prev.model ?? '') ||
      cur.year !== prev.year ||
      (cur.colour ?? '') !== (prev.colour ?? '')
    );
  }, [review]);

  const readiness = review ? approvalReadiness(review, reviewedDocs, enabledCategories) : null;
  const canApprove = readiness?.ready === true;
  const blockedReason = readiness && 'reason' in readiness ? readiness.reason : null;

  const toggle = (set: Set<string>, id: string, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  };

  const openDocument = async (doc: ReviewDocument) => {
    if (!doc.file_url || !doc.document_id) return;
    setOpeningDoc(doc.document_id);
    const url = await getSignedDocumentUrl(doc.file_url);
    setOpeningDoc(null);
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
    else toast.error('Document file could not be loaded');
  };

  const decide = async (decision: 'approve' | 'reject') => {
    if (!review) return;
    if (decision === 'reject' && !rejectionReason.trim()) {
      toast.error(vehicleChangeDecisionMessage('REJECTION_REASON_REQUIRED'));
      return;
    }
    setSubmitting(decision);
    const { data, error } = await supabase.rpc('admin_decide_vehicle_change_request', {
      p_request_id: review.request.id,
      p_decision: decision,
      p_rejection_reason: decision === 'reject' ? rejectionReason.trim() : undefined,
      p_admin_notes: adminNotes.trim() || undefined,
      p_reviewed_document_ids: decision === 'approve' ? Array.from(reviewedDocs) : undefined,
      p_enabled_vehicle_type_ids: decision === 'approve' ? Array.from(enabledCategories) : undefined,
    });
    setSubmitting(null);

    const result = data as { ok?: boolean; code?: string } | null;
    if (error || !result?.ok) {
      const code = result?.code;
      toast.error(error ? 'Could not save the decision. Please try again.' : vehicleChangeDecisionMessage(code));
      if (code === 'VEHICLE_DOCUMENTS_NOT_REVIEWED' || code === 'VEHICLE_DOCUMENTS_NOT_COMPLIANT') {
        void load(review.request.id);
      }
      if (code === 'ALREADY_DECIDED' || code === 'NOT_FOUND') onDecided(decision);
      return;
    }
    toast.success(decision === 'approve' ? 'Vehicle change approved and applied' : 'Vehicle change rejected');
    onDecided(decision);
  };

  const pending = review?.request.status === 'pending';

  return (
    <Dialog open={!!requestId} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Review Vehicle Change Request</DialogTitle>
          <DialogDescription>
            {driverLabel} wants to update their vehicle. Their current vehicle stays active until you approve.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        ) : loadError ? (
          <div className="py-8 text-center text-destructive">{loadError}</div>
        ) : review ? (
          <div className="space-y-5">
            <div className="rounded-lg border">
              <div className="grid grid-cols-3 border-b bg-muted/40 px-3 py-2 text-xs font-medium uppercase text-muted-foreground">
                <span />
                <span>Current</span>
                <span className="text-primary">Requested</span>
              </div>
              {(Object.keys(FIELD_LABELS) as Array<keyof VehicleDetails>).map((field) => {
                const changed = changedFields.includes(field);
                return (
                  <div key={field} className="grid grid-cols-3 px-3 py-1.5 text-sm">
                    <span className="text-muted-foreground">{FIELD_LABELS[field]}</span>
                    <span>{review.request.previous[field] ?? '—'}</span>
                    <span className={changed ? 'font-semibold text-primary' : ''}>
                      {review.request.requested[field] ?? '—'}
                    </span>
                  </div>
                );
              })}
            </div>

            {vehicleDrifted && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>Vehicle changed since submission</AlertTitle>
                <AlertDescription>
                  The live vehicle is now {formatVehicle(review.currentVehicle)} (
                  {review.currentVehicle?.licence_plate}). Approval will be refused; reject and ask the
                  driver to submit again.
                </AlertDescription>
              </Alert>
            )}

            <section className="space-y-2">
              <h3 className="text-sm font-semibold">Vehicle documents</h3>
              {identityChanged && pending && (
                <p className="text-sm text-muted-foreground">
                  The make, model or registration is changing. Only confirm a document if it covers the
                  requested vehicle ({review.request.requested.licence_plate}). Otherwise reject and ask
                  the driver to upload updated documents first.
                </p>
              )}
              {!review.documentRulesAvailable ? (
                <Alert variant="destructive">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription>
                    Document rules are not configured for this driver’s service area, so the request cannot be
                    approved.
                  </AlertDescription>
                </Alert>
              ) : review.documents.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No vehicle documents are required in this driver’s service area.
                </p>
              ) : (
                <div className="divide-y rounded-lg border">
                  {review.documents.map((doc) => {
                    const canConfirm = pending && doc.state === 'approved' && !!doc.document_id;
                    return (
                      <div key={doc.slug} className="flex items-center gap-3 px-3 py-2">
                        <Checkbox
                          id={`doc-${doc.slug}`}
                          disabled={!canConfirm}
                          checked={!!doc.document_id && reviewedDocs.has(doc.document_id)}
                          onCheckedChange={(v) =>
                            doc.document_id &&
                            setReviewedDocs((s) => toggle(s, doc.document_id as string, v === true))
                          }
                        />
                        <div className="min-w-0 flex-1">
                          <Label htmlFor={`doc-${doc.slug}`} className="font-medium">
                            {doc.name}
                          </Label>
                          <div className="text-xs text-muted-foreground">
                            {doc.expiry_date ? `Expires ${new Date(doc.expiry_date).toLocaleDateString()}` : 'No expiry'}
                            {doc.expiring_soon && ' · expiring soon'}
                          </div>
                        </div>
                        <Badge variant="secondary" className={DOC_STATE_STYLES[doc.state]}>
                          {doc.state}
                        </Badge>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={!doc.file_url || openingDoc === doc.document_id}
                          onClick={() => void openDocument(doc)}
                        >
                          {openingDoc === doc.document_id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <ExternalLink className="h-4 w-4" />
                          )}
                          <span className="ml-1">View</span>
                        </Button>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            <section className="space-y-2">
              <h3 className="text-sm font-semibold">Eligible ride categories</h3>
              <p className="text-sm text-muted-foreground">
                Recheck which categories the requested vehicle qualifies for. The selection is applied together
                with the vehicle change.
              </p>
              <div className="grid grid-cols-2 gap-2">
                {review.categories.map((cat) => (
                  <label
                    key={cat.vehicle_type_id}
                    className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
                  >
                    <Checkbox
                      disabled={!pending}
                      checked={enabledCategories.has(cat.vehicle_type_id)}
                      onCheckedChange={(v) =>
                        setEnabledCategories((s) => toggle(s, cat.vehicle_type_id, v === true))
                      }
                    />
                    <span>{cat.name}</span>
                    {cat.is_default && <Badge variant="outline">Default</Badge>}
                  </label>
                ))}
              </div>
            </section>

            {pending ? (
              <>
                <div className="space-y-2">
                  <Label htmlFor="rejection-reason">Reason shown to the driver (required to reject)</Label>
                  <Textarea
                    id="rejection-reason"
                    placeholder="e.g. Please upload the V5C for the new registration."
                    value={rejectionReason}
                    maxLength={500}
                    onChange={(e) => setRejectionReason(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="admin-notes">Internal notes (admins only)</Label>
                  <Textarea
                    id="admin-notes"
                    value={adminNotes}
                    maxLength={1000}
                    onChange={(e) => setAdminNotes(e.target.value)}
                  />
                </div>
                {blockedReason && <p className="text-sm text-muted-foreground">{blockedReason}</p>}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">This request is {review.request.status}.</p>
            )}
          </div>
        ) : null}

        {pending && (
          <DialogFooter className="flex gap-2">
            <Button
              variant="destructive"
              onClick={() => void decide('reject')}
              disabled={submitting !== null || !rejectionReason.trim()}
            >
              {submitting === 'reject' ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <XCircle className="mr-2 h-4 w-4" />
              )}
              Reject
            </Button>
            <Button onClick={() => void decide('approve')} disabled={submitting !== null || !canApprove}>
              {submitting === 'approve' ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle className="mr-2 h-4 w-4" />
              )}
              Approve & Apply
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
