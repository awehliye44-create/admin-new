/**
 * Lock: Driver Details sheet reuses the existing document actions
 * (Add Documents, Approve, Reject, Re-reject) — one shared review flow, no copy.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(p, 'utf8');
const DETAILS = read('src/components/drivers/DriverDetailsDialog.tsx');
const DOCUMENTS_PAGE = read('src/pages/Documents.tsx');
const REVIEW = read('src/components/documents/DocumentReviewDialog.tsx');

describe('Driver Details document actions', () => {
  it('uses the existing Add Documents dialog and the shared review dialog', () => {
    expect(DETAILS).toMatch(/<AdminAddDriverDocumentsDialog/);
    expect(DETAILS).toMatch(/<DocumentReviewDialog/);
    expect(DOCUMENTS_PAGE).toMatch(/<DocumentReviewDialog/);
  });

  it('offers Approve and Reject only for pending documents, Re-reject only for approved ones', () => {
    expect(DETAILS).toMatch(/item\.doc\.status === 'pending'[\s\S]{0,1500}Approve[\s\S]{0,800}Reject/);
    expect(DETAILS).toMatch(/item\.doc\.status === 'approved'[\s\S]{0,700}Re-reject/);
  });

  it('re-rejecting an approved document clears the file so the driver must re-upload', () => {
    expect(REVIEW).toMatch(/document\?\.status === 'approved' && decision === 'rejected'/);
    expect(REVIEW).toMatch(/updatePayload\.file_url = null/);
  });

  it('the Documents page no longer has its own review write', () => {
    expect(DOCUMENTS_PAGE).not.toMatch(/reviewed_by:/);
  });
});
