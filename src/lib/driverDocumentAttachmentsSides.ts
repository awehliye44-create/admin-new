/**
 * Admin dual-side document helpers (Front/Back attachments SSOT).
 * Preferred approval rule lives in UI — not a DB trigger.
 */

export type AdminDocumentAttachment = {
  attachment_id: string;
  document_id: string;
  side: string;
  file_url: string | null;
  storage_path?: string | null;
  original_filename?: string | null;
  mime_type?: string | null;
  is_current?: boolean | null;
  created_at?: string | null;
  updated_at?: string | null;
  superseded_by?: string | null;
};

/** Preferred admin rule: dual-side docs need Front + Back (or legacy Full) before Approve. */
export function documentNeedsBothSides(doc: {
  document_name?: string | null;
  document_type?: string | null;
}): boolean {
  const haystack = `${doc.document_name ?? ''} ${doc.document_type ?? ''}`.toLowerCase();
  if (
    haystack.includes('front and back') ||
    haystack.includes('front & back') ||
    haystack.includes('front/back')
  ) {
    return true;
  }
  const isLicence =
    haystack.includes('licence') || haystack.includes('license') || haystack.includes('dvla');
  const isDriving = haystack.includes('driving') || haystack.includes('dvla');
  return isLicence && isDriving;
}

export function dualSideApproveBlockReason(
  attachments: Array<Pick<AdminDocumentAttachment, 'side'>>,
): string | null {
  const sides = new Set(attachments.map((a) => a.side.toLowerCase()));
  if (sides.has('full')) return null;
  const missing: string[] = [];
  if (!sides.has('front')) missing.push('Front');
  if (!sides.has('back')) missing.push('Back');
  if (missing.length === 0) return null;
  return `Both Front and Back are required before approval. Missing: ${missing.join(' and ')}.`;
}

export function sideDisplayLabel(side: string): string {
  const value = side.toLowerCase();
  if (value === 'front') return 'Front';
  if (value === 'back') return 'Back';
  if (value === 'full') return 'Full';
  return 'Other';
}

/** Replacement/version badge for a current attachment when history exists. */
export function attachmentVersionLabel(input: {
  current: Pick<AdminDocumentAttachment, 'attachment_id' | 'side' | 'created_at' | 'updated_at'>;
  history: Array<
    Pick<AdminDocumentAttachment, 'attachment_id' | 'side' | 'is_current' | 'created_at' | 'superseded_by'>
  >;
}): string | null {
  const prior = input.history.filter(
    (h) =>
      h.side.toLowerCase() === input.current.side.toLowerCase() &&
      h.attachment_id !== input.current.attachment_id &&
      h.is_current === false,
  );
  if (prior.length === 0) return null;
  return `Replaced · ${prior.length} prior version${prior.length === 1 ? '' : 's'}`;
}
