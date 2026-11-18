/**
 * Lock: Admin-assisted document upload SSOT (eligibility + action key).
 * Page access alone must not authorise uploads; registration gates stay shared.
 */
import { describe, expect, it } from 'vitest';
import {
  DOCUMENTS_ADMIN_UPLOAD_ACTION_KEY,
  DOCUMENTS_ADMIN_UPLOAD_ACTION_KEYS,
  DOCUMENTS_ADMIN_UPLOAD_ACTION_LABELS,
  DOCUMENTS_ADMIN_UPLOAD_ACTION_HELP,
  driverRegistrationVerificationComplete,
} from '../../../shared/rolesPermissionsSSOT';

const eligible = {
  email_verified: true,
  phone_verified: true,
  terms_accepted_at: '2026-01-01T00:00:00Z',
  terms_version: 'v1',
};

describe('adminDriverDocumentUploadSSOT', () => {
  it('exposes a dedicated documents.admin_upload action key', () => {
    expect(DOCUMENTS_ADMIN_UPLOAD_ACTION_KEY).toBe('documents.admin_upload');
    expect(DOCUMENTS_ADMIN_UPLOAD_ACTION_KEYS).toEqual(['documents.admin_upload']);
    expect(DOCUMENTS_ADMIN_UPLOAD_ACTION_LABELS['documents.admin_upload']).toBeTruthy();
    expect(DOCUMENTS_ADMIN_UPLOAD_ACTION_HELP['documents.admin_upload']).toMatch(/Pending Review/i);
  });

  it('requires email, phone, and Terms/Service Agreement — rejects incomplete or deleted', () => {
    expect(driverRegistrationVerificationComplete(eligible)).toBe(true);

    expect(
      driverRegistrationVerificationComplete({ ...eligible, email_verified: false }),
    ).toBe(false);

    expect(
      driverRegistrationVerificationComplete({ ...eligible, phone_verified: false }),
    ).toBe(false);

    expect(
      driverRegistrationVerificationComplete({ ...eligible, terms_accepted_at: null }),
    ).toBe(false);

    expect(
      driverRegistrationVerificationComplete({ ...eligible, terms_version: null }),
    ).toBe(false);

    expect(
      driverRegistrationVerificationComplete({ ...eligible, terms_version: '   ' }),
    ).toBe(false);

    expect(
      driverRegistrationVerificationComplete({
        ...eligible,
        deleted_at: '2026-02-01T00:00:00Z',
      }),
    ).toBe(false);
  });
});
