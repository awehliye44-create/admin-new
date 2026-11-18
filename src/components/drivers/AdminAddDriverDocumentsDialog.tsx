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
import { useAdminDriverDocumentChecklist } from '@/hooks/useAdminDriverDocumentChecklist';
import type { AdminChecklistRow } from '@/lib/adminDriverDocumentChecklist';
import { driverRegistrationVerificationComplete } from '../../../shared/rolesPermissionsSSOT';

type DriverForUpload = {
  id: string;
  first_name: string;
  last_name: string;
  driver_code: string | null;
  email_verified?: boolean | null;
  phone_verified?: boolean | null;
  terms_accepted_at?: string | null;
  terms_version?: string | null;
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
  primary: File | null;
  back: File | null;
  expiryDate: string;
};

const EMPTY_DRAFT: Draft = { primary: null, back: null, expiryDate: '' };

function fileExtension(file: File): string {
  const parts = file.name.split('.');
  const raw = parts.length > 1 ? parts.pop()! : '';
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
  return cleaned || 'bin';
}

function loadErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (
    error &&
    typeof error === 'object' &&
    'message' in error &&
    typeof (error as { message: unknown }).message === 'string' &&
    (error as { message: string }).message.trim()
  ) {
    return (error as { message: string }).message;
  }
  return 'Unknown error';
}

function buildStoragePath(
  driverId: string,
  documentTypeKey: string,
  side: string,
  file: File,
): string {
  return `${driverId}/admin/${documentTypeKey}/${side}_${crypto.randomUUID()}.${fileExtension(file)}`;
}

async function uploadSideAndSubmit(args: {
  driverId: string;
  documentTypeId: string;
  documentTypeKey: string;
  side: 'front' | 'back' | 'single';
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

function rowHasPrimaryFile(row: AdminChecklistRow, draft: Draft | undefined): boolean {
  if (!draft?.primary) return false;
  if (row.capture.kind === 'dual') {
    return Boolean(draft.primary && draft.back);
  }
  return true;
}

function primaryFileLabel(row: AdminChecklistRow): string {
  if (row.capture.kind === 'front_only' || row.capture.kind === 'dual') return 'Front file';
  if (row.capture.kind === 'back_only') return 'Back file';
  return 'Upload file';
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
    data: checklist,
    isLoading,
    isError,
    error: loadError,
    refetch,
  } = useAdminDriverDocumentChecklist(open ? driverId : null);

  const rows = checklist?.rows ?? [];
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [submitting, setSubmitting] = useState(false);

  const registrationOk = !!driver && driverRegistrationVerificationComplete(driver);
  const uploadAllowed = canUpload && registrationOk;

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
      rows
        .filter((row) => row.can_upload && rowHasPrimaryFile(row, drafts[row.document_type_id]))
        .map((row) => row.document_type_id),
    [rows, drafts],
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
        ? 'This driver has not completed registration verification (email, phone, and Terms / Service Agreement). Admin upload is blocked until verification is complete.'
        : null;

  const handleSubmit = async () => {
    if (!driver || !uploadAllowed || filledTypeIds.length === 0) return;

    for (const typeId of filledTypeIds) {
      const row = rows.find((r) => r.document_type_id === typeId);
      const draft = drafts[typeId];
      if (!row || !draft?.primary) continue;
      if (row.requires_expiry && !draft.expiryDate) {
        toast.error(`Expiry date is required for ${row.display_name}`);
        return;
      }
      if (row.capture.kind === 'dual' && !draft.back) {
        toast.error(`Front and Back files are required for ${row.display_name}`);
        return;
      }
    }

    setSubmitting(true);
    try {
      for (const typeId of filledTypeIds) {
        const row = rows.find((r) => r.document_type_id === typeId)!;
        const draft = drafts[typeId]!;
        const expiry = row.requires_expiry ? draft.expiryDate || null : null;

        if (row.capture.kind === 'dual') {
          await uploadSideAndSubmit({
            driverId: driver.id,
            documentTypeId: row.document_type_id,
            documentTypeKey: row.document_type_key,
            side: 'front',
            file: draft.primary!,
            expiryDate: expiry,
          });
          await uploadSideAndSubmit({
            driverId: driver.id,
            documentTypeId: row.document_type_id,
            documentTypeKey: row.document_type_key,
            side: 'back',
            file: draft.back!,
            expiryDate: expiry,
          });
        } else {
          const side =
            row.capture.kind === 'front_only'
              ? 'front'
              : row.capture.kind === 'back_only'
                ? 'back'
                : 'single';
          await uploadSideAndSubmit({
            driverId: driver.id,
            documentTypeId: row.document_type_id,
            documentTypeKey: row.document_type_key,
            side,
            file: draft.primary!,
            expiryDate: expiry,
          });
        }
      }

      toast.success('Documents submitted for Pending Review', {
        description: 'Uploaded documents are not auto-approved.',
      });
      await queryClient.invalidateQueries({
        queryKey: ['admin-driver-document-checklist', driver.id],
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
                Loading document checklist…
              </div>
            ) : isError ? (
              <Alert variant="destructive">
                <AlertTitle>Failed to load compliance</AlertTitle>
                <AlertDescription>{loadErrorMessage(loadError)}</AlertDescription>
              </Alert>
            ) : !checklist?.serviceAreaId ? (
              <Alert>
                <AlertTitle>No service area</AlertTitle>
                <AlertDescription>
                  This driver has no assigned service area, so document requirements cannot be listed.
                </AlertDescription>
              </Alert>
            ) : rows.length === 0 ? (
              <Alert>
                <AlertTitle>No document requirements</AlertTitle>
                <AlertDescription>
                  No active document rules are configured for this driver&apos;s service area.
                </AlertDescription>
              </Alert>
            ) : (
              <ScrollArea className="max-h-[55vh] pr-3">
                <div className="space-y-4">
                  {rows.map((row, index) => {
                    const draft = drafts[row.document_type_id] ?? EMPTY_DRAFT;
                    const uploadEnabled = uploadAllowed && row.can_upload && !submitting;
                    return (
                      <div key={row.document_type_id} className="space-y-3">
                        {index > 0 ? <Separator /> : null}
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-medium text-sm">{row.display_name}</p>
                          <Badge variant={row.is_required ? 'secondary' : 'outline'}>
                            {row.requirement_label}
                          </Badge>
                          <Badge variant="outline">{row.status_label}</Badge>
                        </div>

                        {row.can_upload ? (
                          <>
                            <div
                              className={
                                row.capture.kind === 'dual'
                                  ? 'grid gap-3 sm:grid-cols-2'
                                  : 'grid gap-3 max-w-md'
                              }
                            >
                              <div className="space-y-1.5">
                                <Label htmlFor={`primary-${row.document_type_id}`}>
                                  {primaryFileLabel(row)}{' '}
                                  <span className="text-destructive">*</span>
                                </Label>
                                <Input
                                  id={`primary-${row.document_type_id}`}
                                  type="file"
                                  accept="image/*,application/pdf"
                                  disabled={!uploadEnabled}
                                  onChange={(e) =>
                                    updateDraft(row.document_type_id, {
                                      primary: e.target.files?.[0] ?? null,
                                    })
                                  }
                                />
                              </div>
                              {row.capture.kind === 'dual' ? (
                                <div className="space-y-1.5">
                                  <Label htmlFor={`back-${row.document_type_id}`}>
                                    Back file <span className="text-destructive">*</span>
                                  </Label>
                                  <Input
                                    id={`back-${row.document_type_id}`}
                                    type="file"
                                    accept="image/*,application/pdf"
                                    disabled={!uploadEnabled}
                                    onChange={(e) =>
                                      updateDraft(row.document_type_id, {
                                        back: e.target.files?.[0] ?? null,
                                      })
                                    }
                                  />
                                </div>
                              ) : null}
                            </div>

                            {row.requires_expiry ? (
                              <div className="space-y-1.5 max-w-xs">
                                <Label htmlFor={`expiry-${row.document_type_id}`}>
                                  Expiry date <span className="text-destructive">*</span>
                                </Label>
                                <Input
                                  id={`expiry-${row.document_type_id}`}
                                  type="date"
                                  value={draft.expiryDate}
                                  disabled={!uploadEnabled}
                                  onChange={(e) =>
                                    updateDraft(row.document_type_id, {
                                      expiryDate: e.target.value,
                                    })
                                  }
                                />
                              </div>
                            ) : null}
                          </>
                        ) : (
                          <p className="text-xs text-muted-foreground">
                            Upload unavailable — replacement is not open for this document.
                          </p>
                        )}
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
