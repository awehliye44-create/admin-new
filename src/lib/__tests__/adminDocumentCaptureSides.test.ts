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

  it('uses single upload for ordinary certificates', () => {
    expect(
      resolveAdminDocumentCaptureLayout({
        code: 'mot_certificate',
        name: 'MOT Test Certificate',
      }),
    ).toEqual({ kind: 'single', submitSide: 'single' });
    expect(
      resolveAdminDocumentCaptureLayout({
        code: 'profile_photo',
        name: 'Profile Photo',
      }),
    ).toEqual({ kind: 'single', submitSide: 'single' });
  });

  it('requires dual sides only for Front & Back named types / DVLA driving without split', () => {
    expect(
      resolveAdminDocumentCaptureLayout({
        code: 'uk_licence',
        name: 'Driving Licence Front & Back',
      }).kind,
    ).toBe('dual');
    expect(
      documentNeedsCaptureSides({
        code: 'driving_licence',
        name: 'UK Driving Licence',
      }),
    ).toBe(true);
  });
});
