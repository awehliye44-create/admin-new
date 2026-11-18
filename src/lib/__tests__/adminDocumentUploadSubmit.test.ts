/**
 * Admin document upload submit helpers: side path naming, error surfacing,
 * and orphan-cleanup guards.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const removeMock = vi.fn();
const uploadMock = vi.fn();
const rpcMock = vi.fn();
const attachmentEqMock = vi.fn();
const documentsEqMock = vi.fn();

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    storage: {
      from: () => ({
        upload: (...args: unknown[]) => uploadMock(...args),
        remove: (...args: unknown[]) => removeMock(...args),
      }),
    },
    rpc: (...args: unknown[]) => rpcMock(...args),
    from: (table: string) => {
      if (table === 'document_attachments') {
        return {
          select: () => ({
            eq: (...args: unknown[]) => attachmentEqMock(...args),
          }),
        };
      }
      if (table === 'documents') {
        return {
          select: () => ({
            eq: (...args: unknown[]) => documentsEqMock(...args),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  },
}));

import {
  AdminDocumentUploadError,
  buildAdminDocumentStoragePath,
  extractSupabaseErrorFields,
  removeUnreferencedAdminStorageObject,
  uploadSideAndSubmit,
  userFacingUploadError,
} from '@/lib/adminDocumentUploadSubmit';
import { resolveAdminDocumentCaptureLayout } from '@/lib/adminDocumentCaptureSides';

function chainMaybeSingle(result: { data: unknown; error: unknown }) {
  return {
    limit: () => ({
      maybeSingle: async () => result,
    }),
  };
}

describe('adminDocumentUploadSubmit', () => {
  beforeEach(() => {
    removeMock.mockReset();
    uploadMock.mockReset();
    rpcMock.mockReset();
    attachmentEqMock.mockReset();
    documentsEqMock.mockReset();
    attachmentEqMock.mockImplementation(() =>
      chainMaybeSingle({ data: null, error: null }),
    );
    documentsEqMock.mockImplementation(() =>
      chainMaybeSingle({ data: null, error: null }),
    );
    removeMock.mockResolvedValue({ data: null, error: null });
  });

  it('maps capture layouts to Driver attachment sides', () => {
    const v5 = resolveAdminDocumentCaptureLayout({
      code: 'v5_logbook',
      name: 'V5 Logbook (Full)',
    });
    expect(v5).toEqual({ kind: 'single', submitSide: 'full' });

    const front = resolveAdminDocumentCaptureLayout({
      code: 'dvla_front',
      name: 'Licence Front',
    });
    expect(front).toEqual({ kind: 'front_only', submitSide: 'front' });

    const dual = resolveAdminDocumentCaptureLayout({
      code: 'licence',
      name: 'Driving Licence Front & Back',
    });
    expect(dual.kind).toBe('dual');
    if (dual.kind === 'dual') {
      expect(dual.submitSides).toEqual(['front', 'back']);
    }
  });

  it('builds storage paths with the submitted side (full not single)', () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'v5.jpg', {
      type: 'image/jpeg',
    });
    const path = buildAdminDocumentStoragePath(
      'driver-1',
      'v5_logbook',
      'full',
      file,
    );
    expect(path).toMatch(
      /^driver-1\/admin\/v5_logbook\/full_[0-9a-f-]+\.jpg$/,
    );
    expect(path).not.toContain('/single_');
  });

  it('surfaces plain Supabase objects and distinguishes stages', () => {
    const plain = { message: 'new row violates check', code: '23514' };
    expect(extractSupabaseErrorFields(plain)).toEqual({
      message: 'new row violates check',
      code: '23514',
      details: undefined,
      hint: undefined,
    });
    expect(userFacingUploadError(plain)).toBe('new row violates check');

    const staged = new AdminDocumentUploadError({
      stage: 'submit',
      code: 'REPLACEMENT_NOT_ALLOWED',
      userMessage: 'An approved document is still valid; replacement is not open yet',
      diagnostic: {
        stage: 'submit',
        code: 'REPLACEMENT_NOT_ALLOWED',
        message: 'An approved document is still valid; replacement is not open yet',
      },
    });
    expect(staged.stage).toBe('submit');
    expect(userFacingUploadError(staged)).toMatch(/replacement is not open/i);
  });

  it('removes unreferenced storage after definitive RPC error', async () => {
    uploadMock.mockResolvedValue({ error: null });
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: 'side check failed', code: '23514' },
    });

    const file = new File([new Uint8Array([9])], 'doc.jpg', {
      type: 'image/jpeg',
    });

    let caught: unknown;
    try {
      await uploadSideAndSubmit({
        driverId: 'd1',
        documentTypeId: 't1',
        documentTypeKey: 'v5_logbook',
        side: 'full',
        file,
        expiryDate: null,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AdminDocumentUploadError);
    expect((caught as AdminDocumentUploadError).stage).toBe('submit');
    expect((caught as AdminDocumentUploadError).message).toMatch(/side check failed/);
    expect(removeMock).toHaveBeenCalled();
    const removedPath = removeMock.mock.calls[0][0][0] as string;
    expect(removedPath).toContain('/admin/v5_logbook/full_');
  });

  it('does not remove storage when path is already referenced', async () => {
    attachmentEqMock.mockImplementation((col: string) => {
      if (col === 'storage_path') {
        return chainMaybeSingle({ data: { id: 'att-1' }, error: null });
      }
      return chainMaybeSingle({ data: null, error: null });
    });

    const result = await removeUnreferencedAdminStorageObject(
      'd1/admin/v5_logbook/full_abc.jpg',
    );
    expect(result).toEqual({ removed: false, skippedReferenced: true });
    expect(removeMock).not.toHaveBeenCalled();
  });

  it('keeps storage on ambiguous network failure when commit cannot be ruled out', async () => {
    uploadMock.mockResolvedValue({ error: null });
    rpcMock.mockRejectedValue({ message: 'Failed to fetch' });
    // Lookup returns unknown/error → must not delete
    attachmentEqMock.mockImplementation(() =>
      chainMaybeSingle({ data: null, error: { message: 'rls' } }),
    );

    const file = new File([new Uint8Array([1])], 'x.jpg', {
      type: 'image/jpeg',
    });
    await expect(
      uploadSideAndSubmit({
        driverId: 'd1',
        documentTypeId: 't1',
        documentTypeKey: 'mot_certificate',
        side: 'full',
        file,
        expiryDate: null,
      }),
    ).rejects.toBeInstanceOf(AdminDocumentUploadError);

    expect(removeMock).not.toHaveBeenCalled();
  });

  it('throws storage-stage error without calling RPC when upload fails', async () => {
    uploadMock.mockResolvedValue({
      error: { message: 'Bucket RLS denied', code: '403' },
    });
    const file = new File([new Uint8Array([1])], 'x.jpg', {
      type: 'image/jpeg',
    });
    let caught: unknown;
    try {
      await uploadSideAndSubmit({
        driverId: 'd1',
        documentTypeId: 't1',
        documentTypeKey: 'mot_certificate',
        side: 'full',
        file,
        expiryDate: null,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AdminDocumentUploadError);
    expect((caught as AdminDocumentUploadError).stage).toBe('storage');
    expect((caught as AdminDocumentUploadError).message).toMatch(/Bucket RLS denied/);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('treats success:false RPC payload as submit failure and cleans orphan', async () => {
    uploadMock.mockResolvedValue({ error: null });
    rpcMock.mockResolvedValue({
      data: {
        success: false,
        error: 'REPLACEMENT_NOT_ALLOWED',
        message: 'An approved document is still valid; replacement is not open yet',
      },
      error: null,
    });
    const file = new File([new Uint8Array([1])], 'x.jpg', {
      type: 'image/jpeg',
    });
    let caught: unknown;
    try {
      await uploadSideAndSubmit({
        driverId: 'd1',
        documentTypeId: 't1',
        documentTypeKey: 'mot_certificate',
        side: 'full',
        file,
        expiryDate: null,
      });
    } catch (err) {
      caught = err;
    }
    expect((caught as AdminDocumentUploadError).stage).toBe('submit');
    expect((caught as AdminDocumentUploadError).code).toBe('REPLACEMENT_NOT_ALLOWED');
    expect(removeMock).toHaveBeenCalled();
  });
});
