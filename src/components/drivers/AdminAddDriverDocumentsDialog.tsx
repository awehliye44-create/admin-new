import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { supabase } from '@/integrations/supabase/client';
import {
  useDriverDocumentCompliance,
  reviewLabel,
  validityLabel,
  type DriverDocumentComplianceRow,
} from '@/hooks/useDriverDocumentCompliance';
import { driverRegistrationVerificationComplete } from '../../../shared/rolesPermissionsSSOT';

type DriverForUpload = {
  id: string;
  first_name: string;
  last_name: string;
  driver_code: string | null;
  email_verified?: boolean | null;
  phone_verified?: boolean | null;
  terms_accepted_at?: string | null;
  deleted_at?: string | null;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  driver: DriverForUpload | null;
  canUpload: boolean;
  onSubmitted?: () => void;
};

type Draft = {
  front: File | null;
  back: File | null;
  expiryDate: string;
};

const EMPTY_DRAFT: Draft = { front: null, back: null, expiryDate: '' };

function isUploadableRow(row: DriverDocumentComplianceRow): boolean {
  if (row.can_upload_replacement === true) return true;
  const status = row.expiry_status;
  return (
    status === 'missing' ||
    status === 'rejected' ||
    status === 'expired' ||
    status === 'pending'
  );
}

function fileExtension(file: File): string {
  const parts = file.name.split('.');
  const raw = parts.length > 1 ? parts.pop()! : '';
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
  return cleaned || 'bin';
}

function buildStoragePath(
  driverId: string,
  documentTypeKey: string,
  side: 'front' | 'back',
  file: File,
): string {
  return `${driverId}/admin/${documentTypeKey}/${side}_${crypto.randomUUID()}.${fileExtension(file)}`;
}

async function uploadSideAndSubmit(args: {
  driverId: string;
  documentTypeId: string;
  documentTypeKey: string;
  side: 'front' | 'back';
  file: File;
  expiryDate: string | null;
}): Promise<void> {
  const storagePath = buildStoragePath(
    args.driverId,
    args.documentTypeKey,
    args.side,
    args.file,
  );

  const { error: uploadError } = await supabase.storage
    .from('driver-documents')
    .upload(storagePath, args.file, {
      contentType: args.file.type || undefined,
      upsert: false,
    });
  if (uploadError) throw uploadError;

  const { data, error } = await supabase.rpc('admin_submit_driver_document', {
    p_driver_id: args.driverId,
    p_document_type_id: args.documentTypeId,
    p_storage_path: storagePath,
    p_side: args.side,
    p_expiry_date: args.expiryDate,
    p_mime_type: args.file.type || null,
    p_original_filename: args.file.name,
    p_file_size_bytes: args.file.size,
    p_idempotency_key: crypto.randomUUID(),
  });
  if (error) throw error;

  const result = data as { success?: boolean; message?: string; error?: string } | null;
  if (result && result.success === false) {
    throw new Error(result.message || result.error || 'Document submit failed');
  }
}

export function AdminAddDriverDocumentsDialog({
  open,
  onOpenChange,
  driver,
  canUpload,
  onSubmitted,
}: Props) {
  const queryClient = useQueryClient();
  const driverId = driver?.id ?? null;
  const {
    data: rows = [],
    isLoading,
    isError,
    error: loadError,
    refetch,
  } = useDriverDocumentCompliance(open ? driverId : null);

  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [submitting, setSubmitting] = useState(false);

  const registrationOk = !!driver && driverRegistrationVerificationComplete(driver);
  const uploadAllowed = canUpload && registrationOk;

  const uploadableRows = useMemo(() => {
    return [...rows]
      .filter(isUploadableRow)
      .sort((a, b) => Number(b.is_required) - Number(a.is_required));
  }, [rows]);

  useEffect(() => {
    if (!open) {
      setDrafts({});
      setSubmitting(false);
    }
  }, [open, driverId]);

  const driverLabel = driver
    ? `${driver.first_name} ${driver.last_name}${driver.driver_code ? ` · ${driver.driver_code}` : ''}`
    : '';

  const filledTypeIds = useMemo(
    () =>
      uploadableRows
        .filter((row) => drafts[row.document_type_id]?.front)
        .map((row) => row.document_type_id),
    [uploadableRows, drafts],
  );

  const updateDraft = (documentTypeId: string, patch: Partial<Draft>) => {
    setDrafts((prev) => ({
      ...prev,
      [documentTypeId]: { ...(prev[documentTypeId] ?? EMPTY_DRAFT), ...patch },
    }));
  };

  const disabledReason = !driver
    ? 'Select a driver first.'
    : !canUpload
      ? 'You do not have permission to upload documents on behalf of drivers (documents.admin_upload).'
      : !registrationOk
        ? 'This driver has not completed registration verification (email, phone, and Terms). Admin upload is blocked until verification is complete.'
        : null;

  const handleSubmit = async () => {
    if (!driver || !uploadAllowed || filledTypeIds.length === 0) return;

    for (const typeId of filledTypeIds) {
      const row = uploadableRows.find((r) => r.document_type_id === typeId);
      const draft = drafts[typeId];
      if (!row || !draft?.front) continue;
      if (row.has_expiry && !draft.expiryDate) {
        toast.error(`Expiry date is required for ${row.display_name}`);
        return;
      }
    }

    setSubmitting(true);
    try {
      for (const typeId of filledTypeIds) {
        const row = uploadableRows.find((r) => r.document_type_id === typeId)!;
        const draft = drafts[typeId]!;
        const expiry = row.has_expiry ? draft.expiryDate || null : null;

        await uploadSideAndSubmit({
          driverId: driver.id,
          documentTypeId: row.document_type_id,
          documentTypeKey: row.document_type_key,
          side: 'front',
          file: draft.front!,
          expiryDate: expiry,
        });

        if (draft.back) {
          await uploadSideAndSubmit({
            driverId: driver.id,
            documentTypeId: row.document_type_id,
            documentTypeKey: row.document_type_key,
            side: 'back',
            file: draft.back,
            expiryDate: expiry,
          });
        }
      }

      toast.success('Documents submitted for Pending Review', {
        description: 'Uploaded documents are not auto-approved.',
      });
      await queryClient.invalidateQueries({
        queryKey: ['driver-document-compliance', driver.id],
      });
      await refetch();
      setDrafts({});
      onSubmitted?.();
      onOpenChange(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Upload failed';
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Add driver documents</DialogTitle>
          <DialogDescription>
            Upload compliance documents on behalf of {driverLabel || 'the selected driver'}.
            Submitted files enter Pending Review — they are not auto-approved.
          </DialogDescription>
        </DialogHeader>

        {disabledReason ? (
          <Alert variant="destructive">
            <AlertTitle>Upload unavailable</AlertTitle>
            <AlertDescription>{disabledReason}</AlertDescription>
          </Alert>
        ) : (
          <div className="flex flex-col gap-3 min-h-0 flex-1">
            {isLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-8 justify-center">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading document compliance…
              </div>
            ) : isError ? (
              <Alert variant="destructive">
                <AlertTitle>Failed to load compliance</AlertTitle>
                <AlertDescription>
                  {loadError instanceof Error ? loadError.message : 'Unknown error'}
                </AlertDescription>
              </Alert>
            ) : uploadableRows.length === 0 ? (
              <Alert>
                <AlertTitle>Nothing to upload</AlertTitle>
                <AlertDescription>
                  No missing, rejected, expired, pending, or renewal-open document types for this driver.
                </AlertDescription>
              </Alert>
            ) : (
              <ScrollArea className="max-h-[55vh] pr-3">
                <div className="space-y-4">
                  {uploadableRows.map((row, index) => {
                    const draft = drafts[row.document_type_id] ?? EMPTY_DRAFT;
                    return (
                      <div key={row.document_type_id} className="space-y-3">
                        {index > 0 ? <Separator /> : null}
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-medium text-sm">{row.display_name}</p>
                          {row.is_required ? (
                            <Badge variant="secondary">Required</Badge>
                          ) : (
                            <Badge variant="outline">Optional</Badge>
                          )}
                          <Badge variant="outline">{reviewLabel(row)}</Badge>
                          {row.has_expiry ? (
                            <Badge variant="outline">{validityLabel(row)}</Badge>
                          ) : null}
                        </div>

                        <div className="grid gap-3 sm:grid-cols-2">
                          <div className="space-y-1.5">
                            <Label htmlFor={`front-${row.document_type_id}`}>
                              Front file <span className="text-destructive">*</span>
                            </Label>
                            <Input
                              id={`front-${row.document_type_id}`}
                              type="file"
                              accept="image/*,application/pdf"
                              disabled={submitting}
                              onChange={(e) =>
                                updateDraft(row.document_type_id, {
                                  front: e.target.files?.[0] ?? null,
                                })
                              }
                            />
                          </div>
                          <div className="space-y-1.5">
                            <Label htmlFor={`back-${row.document_type_id}`}>Back file (optional)</Label>
                            <Input
                              id={`back-${row.document_type_id}`}
                              type="file"
                              accept="image/*,application/pdf"
                              disabled={submitting}
                              onChange={(e) =>
                                updateDraft(row.document_type_id, {
                                  back: e.target.files?.[0] ?? null,
                                })
                              }
                            />
                          </div>
                        </div>

                        {row.has_expiry ? (
                          <div className="space-y-1.5 max-w-xs">
                            <Label htmlFor={`expiry-${row.document_type_id}`}>
                              Expiry date <span className="text-destructive">*</span>
                            </Label>
                            <Input
                              id={`expiry-${row.document_type_id}`}
                              type="date"
                              value={draft.expiryDate}
                              disabled={submitting}
                              onChange={(e) =>
                                updateDraft(row.document_type_id, {
                                  expiryDate: e.target.value,
                                })
                              }
                            />
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </ScrollArea>
            )}
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={
              !uploadAllowed ||
              submitting ||
              isLoading ||
              isError ||
              filledTypeIds.length === 0
            }
          >
            {submitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Submitting…
              </>
            ) : (
              `Submit${filledTypeIds.length ? ` (${filledTypeIds.length})` : ''}`
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
