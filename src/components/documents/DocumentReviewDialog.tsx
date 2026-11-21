import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { supabase } from '@/integrations/supabase/client';
import { adminPageMutate } from '@/lib/adminPageGatedData';

export type DocumentReviewDecision = 'approved' | 'rejected';

export type DocumentReviewTarget = {
  id: string;
  /** Current stored status — `approved` + reject decision = re-rejection. */
  status: string;
  document_name: string;
  driver_id: string;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  document: DocumentReviewTarget | null;
  decision: DocumentReviewDecision | null;
  driverName?: string;
  /** Admin page the reviewer is on; must be allowed to update documents. */
  pageSlug: 'documents' | 'drivers';
  onReviewed?: () => void;
};

/**
 * Single document review flow (Approve / Reject / Re-reject) shared by the
 * Documents page and the Driver Details sheet.
 */
export function DocumentReviewDialog({
  open,
  onOpenChange,
  document,
  decision,
  driverName,
  pageSlug,
  onReviewed,
}: Props) {
  const queryClient = useQueryClient();
  const [rejectionReason, setRejectionReason] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (open) setRejectionReason('');
  }, [open, document?.id, decision]);

  const isReReject = document?.status === 'approved' && decision === 'rejected';

  const handleReview = async () => {
    if (!document || !decision) {
      toast.error('Please select a status');
      return;
    }
    if (decision === 'rejected' && !rejectionReason.trim()) {
      toast.error('Please provide a rejection reason');
      return;
    }

    setIsSaving(true);
    try {
      const { data: authData, error: authError } = await supabase.auth.getUser();
      if (authError || !authData.user?.id) {
        throw new Error('Your admin session expired. Sign in again, then retry approve/reject.');
      }

      const updatePayload: Record<string, unknown> = {
        status: decision,
        rejection_reason: decision === 'rejected' ? rejectionReason.trim() : null,
        reviewed_at: new Date().toISOString(),
        reviewed_by: authData.user.id,
      };

      // On re-rejection, clear the file so the driver must re-upload
      if (isReReject) {
        updatePayload.file_url = null;
      }

      const result = await adminPageMutate<{ status?: string; id?: string }>(
        pageSlug,
        'documents',
        'update',
        { id: document.id, patch: updatePayload },
      );

      const savedStatus = result.row?.status;
      if (!result.row) {
        throw new Error('Review did not update any document row. Refresh the list and try again.');
      }
      if (savedStatus !== decision) {
        throw new Error(
          `Review did not stick (status is still “${savedStatus ?? 'unknown'}”). Refresh and retry, or check staff document permissions.`,
        );
      }

      toast.success(
        isReReject
          ? 'Document re-rejected — driver will be prompted to re-upload'
          : decision === 'approved'
            ? 'Document approved — driver eligibility will refresh automatically'
            : 'Document rejected — driver can re-upload from My Documents',
      );

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['documents-review'] }),
        queryClient.invalidateQueries({ queryKey: ['driver-doc-compliance', document.driver_id] }),
        queryClient.invalidateQueries({ queryKey: ['admin-driver-document-checklist', document.driver_id] }),
      ]);
      onReviewed?.();
      onOpenChange(false);
    } catch (err: unknown) {
      console.error('Error reviewing document:', err);
      const raw =
        err instanceof Error
          ? err.message
          : typeof err === 'object' && err && 'message' in err
            ? String((err as { message?: unknown }).message || '')
            : '';
      const friendly = /syntax error at or near/i.test(raw)
        ? 'Document review failed on the server. Refresh and retry — if it persists, the admin mutate fix may not be applied yet.'
        : raw || 'Failed to review document';
      toast.error(friendly);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!isSaving) onOpenChange(next); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {decision === 'approved'
              ? 'Approve Document'
              : isReReject
                ? 'Re-reject Document'
                : 'Reject Document'}
          </DialogTitle>
          <DialogDescription>
            {document?.document_name}
            {driverName ? ` - ${driverName}` : ''}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {decision === 'rejected' && (
            <div className="space-y-3">
              {isReReject && (
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
          {decision === 'approved' && (
            <div className="space-y-2 rounded-md border border-emerald-200 bg-emerald-50/60 p-3 text-sm text-emerald-950">
              <p className="font-medium">Approve this document?</p>
              <ul className="list-disc space-y-1 pl-4 text-muted-foreground">
                <li>Marks it verified for this driver.</li>
                <li>When every required document is approved and valid, onboarding unlocks automatically — no extra step.</li>
                <li>Expired or missing required docs still keep the driver offline.</li>
              </ul>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving}>
            Cancel
          </Button>
          <Button
            onClick={handleReview}
            disabled={isSaving || (decision === 'rejected' && !rejectionReason.trim())}
            variant={decision === 'rejected' ? 'destructive' : 'default'}
          >
            {isSaving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
            {decision === 'approved' ? 'Approve' : 'Reject'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
