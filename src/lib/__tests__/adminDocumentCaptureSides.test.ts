import { describe, expect, it } from 'vitest';
import {
  documentNeedsCaptureSides,
  resolveAdminDocumentCaptureLayout,
  resolveNamedSingleDocumentSide,
} from '@/lib/adminDocumentCaptureSides';

describe('adminDocumentCaptureSides', () => {
  it('treats Admin-named Front/Back types as single-side, not dual', () => {
    expect(
      documentNeedsCaptureSides({
        code: 'dvla_driving_license',
        name: 'DVLA Driving Licence - Front',
      }),
    ).toBe(false);
    expect(
      resolveNamedSingleDocumentSide({
        code: 'dvla_driving_license',
        name: 'DVLA Driving Licence - Front',
      }),
    ).toBe('front');
    expect(
      resolveAdminDocumentCaptureLayout({
        code: 'dvla_driving_license',
        name: 'DVLA Driving Licence - Front',
      }),
    ).toEqual({ kind: 'front_only', submitSide: 'front' });
  });

  it('uses single-file UI with Driver SSOT submitSide full for ordinary certificates', () => {
    expect(
      resolveAdminDocumentCaptureLayout({
        code: 'mot_certificate',
        name: 'MOT Test Certificate',
      }),
    ).toEqual({ kind: 'single', submitSide: 'full' });
    expect(
      resolveAdminDocumentCaptureLayout({
        code: 'profile_photo',
        name: 'Profile Photo',
      }),
    ).toEqual({ kind: 'single', submitSide: 'full' });
    expect(
      resolveAdminDocumentCaptureLayout({
        code: 'v5_logbook',
        name: 'V5 Logbook (Full)',
      }),
    ).toEqual({ kind: 'single', submitSide: 'full' });
  });

  it('requires dual sides only for Front & Back named types / DVLA driving without split', () => {
    const dual = resolveAdminDocumentCaptureLayout({
      code: 'uk_licence',
      name: 'Driving Licence Front & Back',
    });
    expect(dual.kind).toBe('dual');
    if (dual.kind === 'dual') {
      expect(dual.submitSides).toEqual(['front', 'back']);
    }
    expect(
      documentNeedsCaptureSides({
        code: 'driving_licence',
        name: 'UK Driving Licence',
      }),
    ).toBe(true);
  });

  it('preserves front-only and back-only named Admin split types', () => {
    expect(
      resolveAdminDocumentCaptureLayout({
        code: 'dvla_driving_license',
        name: 'DVLA Driving Licence - Back',
      }),
    ).toEqual({ kind: 'back_only', submitSide: 'back' });
  });
});
