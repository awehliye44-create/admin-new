/**
 * Admin Add Documents: storage upload → admin_submit_driver_document,
 * with Driver-parity orphan cleanup and safe error surfacing.
 */
import { supabase } from '@/integrations/supabase/client';

export type AdminAttachmentSubmitSide = 'front' | 'back' | 'full' | 'other';

export type AdminDocumentUploadStage = 'storage' | 'submit';

export type AdminDocumentUploadFailure = {
  stage: AdminDocumentUploadStage;
  /** Safe user-facing message (no storage paths / credentials). */
  userMessage: string;
  code?: string;
  /** Diagnostic-only; never toast raw paths. */
  diagnostic: {
    stage: AdminDocumentUploadStage;
    code?: string;
    message?: string;
    details?: string;
    hint?: string;
  };
};

export class AdminDocumentUploadError extends Error {
  readonly stage: AdminDocumentUploadStage;
  readonly code?: string;
  readonly diagnostic: AdminDocumentUploadFailure['diagnostic'];

  constructor(failure: AdminDocumentUploadFailure) {
    super(failure.userMessage);
    this.name = 'AdminDocumentUploadError';
    this.stage = failure.stage;
    this.code = failure.code;
    this.diagnostic = failure.diagnostic;
  }
}

type SupabaseLikeError = {
  message?: unknown;
  code?: unknown;
  details?: unknown;
  hint?: unknown;
  statusCode?: unknown;
  name?: unknown;
};

function asRecord(error: unknown): SupabaseLikeError | null {
  if (!error || typeof error !== 'object') return null;
  return error as SupabaseLikeError;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Extract message/code from Error or plain Supabase error objects. */
export function extractSupabaseErrorFields(error: unknown): {
  message?: string;
  code?: string;
  details?: string;
  hint?: string;
} {
  if (error instanceof AdminDocumentUploadError) {
    return {
      message: error.message,
      code: error.code,
      details: error.diagnostic.details,
      hint: error.diagnostic.hint,
    };
  }
  if (error instanceof Error) {
    const rec = asRecord(error);
    return {
      message: error.message.trim() || undefined,
      code: readString(rec?.code) ?? readString(rec?.statusCode),
      details: readString(rec?.details),
      hint: readString(rec?.hint),
    };
  }
  const rec = asRecord(error);
  if (!rec) return {};
  return {
    message: readString(rec.message),
    code: readString(rec.code) ?? readString(rec.statusCode),
    details: readString(rec.details),
    hint: readString(rec.hint),
  };
}

export function userFacingUploadError(error: unknown): string {
  if (error instanceof AdminDocumentUploadError) return error.message;
  const fields = extractSupabaseErrorFields(error);
  if (fields.message) return fields.message;
  return 'Document upload failed. Please try again.';
}

export function logAdminDocumentUploadFailure(error: unknown): void {
  const fields = extractSupabaseErrorFields(error);
  const stage =
    error instanceof AdminDocumentUploadError ? error.stage : 'unknown';
  // Never log storage paths, filenames, or file bytes.
  console.error('[admin-document-upload]', {
    stage,
    code: fields.code ?? null,
    message: fields.message ?? null,
    details: fields.details ?? null,
    hint: fields.hint ?? null,
  });
}

function fileExtension(file: File): string {
  const parts = file.name.split('.');
  const raw = parts.length > 1 ? parts.pop()! : '';
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
  return cleaned || 'bin';
}

export function buildAdminDocumentStoragePath(
  driverId: string,
  documentTypeKey: string,
  side: AdminAttachmentSubmitSide,
  file: File,
): string {
  return `${driverId}/admin/${documentTypeKey}/${side}_${crypto.randomUUID()}.${fileExtension(file)}`;
}

/**
 * Whether an attachment/document already references the path.
 * `unknown` = lookup failed (e.g. RLS) — callers must not delete on ambiguity.
 */
export async function isAdminStoragePathReferenced(
  storagePath: string,
): Promise<'yes' | 'no' | 'unknown'> {
  const { data: byPath, error: pathError } = await supabase
    .from('document_attachments')
    .select('id')
    .eq('storage_path', storagePath)
    .limit(1)
    .maybeSingle();
  if (pathError) return 'unknown';
  if (byPath?.id) return 'yes';

  const { data: byUrl, error: urlError } = await supabase
    .from('document_attachments')
    .select('id')
    .eq('file_url', storagePath)
    .limit(1)
    .maybeSingle();
  if (urlError) return 'unknown';
  if (byUrl?.id) return 'yes';

  const { data: doc, error: docError } = await supabase
    .from('documents')
    .select('id')
    .eq('file_url', storagePath)
    .limit(1)
    .maybeSingle();
  if (docError) return 'unknown';
  if (doc?.id) return 'yes';

  return 'no';
}

/**
 * Remove a newly uploaded object only when it is not referenced by any
 * document/attachment row. Used after definitive submit failure, or after
 * verifying an ambiguous network failure did not commit.
 */
export async function removeUnreferencedAdminStorageObject(
  storagePath: string,
): Promise<{ removed: boolean; skippedReferenced: boolean }> {
  const referenced = await isAdminStoragePathReferenced(storagePath);
  if (referenced === 'yes' || referenced === 'unknown') {
    return { removed: false, skippedReferenced: referenced === 'yes' };
  }
  const { error } = await supabase.storage
    .from('driver-documents')
    .remove([storagePath]);
  if (error) {
    const fields = extractSupabaseErrorFields(error);
    console.error('[admin-document-upload]', {
      stage: 'storage_cleanup',
      code: fields.code ?? null,
      message: fields.message ?? null,
    });
    return { removed: false, skippedReferenced: false };
  }
  return { removed: true, skippedReferenced: false };
}

function isAmbiguousNetworkFailure(error: unknown): boolean {
  const fields = extractSupabaseErrorFields(error);
  const blob = `${fields.message ?? ''} ${fields.details ?? ''} ${fields.code ?? ''}`.toLowerCase();
  return (
    blob.includes('failed to fetch') ||
    blob.includes('networkerror') ||
    blob.includes('network request failed') ||
    blob.includes('fetch failed') ||
    blob.includes('timeout') ||
    blob.includes('abort') ||
    fields.code === 'ECONNABORTED' ||
    fields.code === 'ETIMEDOUT'
  );
}

async function cleanupAfterSubmitFailure(
  storagePath: string,
  error: unknown,
  definitive: boolean,
): Promise<void> {
  if (!definitive || isAmbiguousNetworkFailure(error)) {
    const referenced = await isAdminStoragePathReferenced(storagePath);
    // Keep the object when committed or when we cannot prove it is unreferenced.
    if (referenced !== 'no') return;
  }
  await removeUnreferencedAdminStorageObject(storagePath);
}

function storageFailure(error: unknown): AdminDocumentUploadError {
  const fields = extractSupabaseErrorFields(error);
  return new AdminDocumentUploadError({
    stage: 'storage',
    code: fields.code,
    userMessage:
      fields.message ||
      'File upload to storage failed. Please try again.',
    diagnostic: {
      stage: 'storage',
      code: fields.code,
      message: fields.message,
      details: fields.details,
      hint: fields.hint,
    },
  });
}

function submitFailure(
  error: unknown,
  fallbackMessage: string,
): AdminDocumentUploadError {
  const fields = extractSupabaseErrorFields(error);
  return new AdminDocumentUploadError({
    stage: 'submit',
    code: fields.code,
    userMessage: fields.message || fallbackMessage,
    diagnostic: {
      stage: 'submit',
      code: fields.code,
      message: fields.message,
      details: fields.details,
      hint: fields.hint,
    },
  });
}

export async function uploadSideAndSubmit(args: {
  driverId: string;
  documentTypeId: string;
  documentTypeKey: string;
  side: AdminAttachmentSubmitSide;
  file: File;
  expiryDate: string | null;
}): Promise<void> {
  const storagePath = buildAdminDocumentStoragePath(
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
  if (uploadError) {
    throw storageFailure(uploadError);
  }

  let rpcData: unknown;
  let rpcError: unknown;
  try {
    const response = await supabase.rpc('admin_submit_driver_document', {
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
    rpcData = response.data;
    rpcError = response.error;
  } catch (thrown) {
    // Ambiguous transport failure — verify commit before deleting.
    await cleanupAfterSubmitFailure(storagePath, thrown, false);
    throw submitFailure(
      thrown,
      'Document submission failed. Please try again.',
    );
  }

  if (rpcError) {
    // PostgREST error ⇒ transaction did not commit; still guard referenced paths.
    await cleanupAfterSubmitFailure(storagePath, rpcError, true);
    throw submitFailure(
      rpcError,
      'Document submission failed. Please try again.',
    );
  }

  const result = rpcData as
    | { success?: boolean; message?: string; error?: string }
    | null;
  if (result && result.success === false) {
    const appErr = {
      message: result.message || result.error || 'Document submit failed',
      code: result.error,
    };
    await cleanupAfterSubmitFailure(storagePath, appErr, true);
    throw submitFailure(appErr, 'Document submission failed. Please try again.');
  }
}
