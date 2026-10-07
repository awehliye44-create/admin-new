import { describe, expect, it } from 'vitest';
import {
  approvalReadiness,
  changedVehicleFields,
  parseVehicleChangeReview,
  vehicleChangeDecisionMessage,
} from '../vehicleChangeReview';

const payload = {
  ok: true,
  request: {
    id: 'r1',
    status: 'pending',
    requested: { make: 'Toyota', model: 'Prius', year: 2023, colour: 'Grey', licence_plate: 'LM23 ABC' },
    previous: { make: 'Toyota', model: 'Corrolla', year: 2022, colour: 'Blue', licence_plate: 'KX14HLD' },
    rejection_reason: null,
    admin_notes: null,
    created_at: '2026-10-07T10:00:00Z',
  },
  current_vehicle: {
    id: 'v1', make: 'Toyota', model: 'Corrolla', year: 2022, colour: 'Blue',
    licence_plate: 'KX14HLD', belongs_to_driver: true,
  },
  vehicle_documents: {
    rules_available: true,
    code: null,
    documents: [
      { slug: 'v5_logbook', name: 'V5C', state: 'approved', document_id: 'd1', expiring_soon: false },
      { slug: 'mot_certificate', name: 'MOT', state: 'approved', document_id: 'd2', expiring_soon: true },
    ],
  },
  categories: [
    { vehicle_type_id: 'go', name: 'ONECAB GO', is_default: true, enabled: true },
    { vehicle_type_id: 'comfort', name: 'Comfort', enabled: false },
  ],
};

describe('parseVehicleChangeReview', () => {
  it('parses the server payload', () => {
    const r = parseVehicleChangeReview(payload)!;
    expect(r.request.requested.licence_plate).toBe('LM23 ABC');
    expect(r.documents).toHaveLength(2);
    expect(r.documents[1].expiring_soon).toBe(true);
    expect(r.categories.map((c) => c.enabled)).toEqual([true, false]);
    expect(r.currentVehicle?.belongs_to_driver).toBe(true);
  });

  it('rejects failed or malformed payloads', () => {
    expect(parseVehicleChangeReview({ ok: false, code: 'NOT_FOUND' })).toBeNull();
    expect(parseVehicleChangeReview(null)).toBeNull();
    expect(parseVehicleChangeReview({ ok: true, request: { id: 'x', status: 'weird' } })).toBeNull();
  });

  it('drops documents with unknown states', () => {
    const r = parseVehicleChangeReview({
      ...payload,
      vehicle_documents: { rules_available: true, documents: [{ slug: 'v5_logbook', state: '???' }] },
    })!;
    expect(r.documents).toHaveLength(0);
  });
});

describe('changedVehicleFields', () => {
  it('ignores plate spacing and case-only differences', () => {
    const r = parseVehicleChangeReview({
      ...payload,
      request: {
        ...payload.request,
        requested: { ...payload.request.previous, make: 'TOYOTA', licence_plate: 'kx14 hld', colour: 'Red' },
      },
    })!;
    expect(changedVehicleFields(r)).toEqual(['colour']);
  });
});

describe('approvalReadiness', () => {
  const review = parseVehicleChangeReview(payload)!;

  it('requires every current vehicle document to be confirmed', () => {
    const res = approvalReadiness(review, new Set(['d1']), new Set(['go']));
    expect(res).toEqual({ ready: false, reason: 'Confirm you reviewed: MOT.' });
  });

  it('requires at least one category', () => {
    expect(approvalReadiness(review, new Set(['d1', 'd2']), new Set())).toMatchObject({ ready: false });
  });

  it('blocks non-compliant documents', () => {
    const bad = parseVehicleChangeReview({
      ...payload,
      vehicle_documents: {
        rules_available: true,
        documents: [{ slug: 'private_hire_insurance', name: 'Insurance', state: 'expired', document_id: 'd3' }],
      },
    })!;
    expect(approvalReadiness(bad, new Set(['d3']), new Set(['go']))).toEqual({
      ready: false,
      reason: 'Vehicle documents not compliant: Insurance (expired).',
    });
  });

  it('fails closed when the service area has no document rules', () => {
    const none = parseVehicleChangeReview({
      ...payload,
      vehicle_documents: { rules_available: false, code: 'SERVICE_AREA_DOCUMENT_RULES_NOT_CONFIGURED', documents: [] },
    })!;
    expect(approvalReadiness(none, new Set(), new Set(['go'])).ready).toBe(false);
  });

  it('is ready when documents are reviewed and a category is kept', () => {
    expect(approvalReadiness(review, new Set(['d1', 'd2']), new Set(['go']))).toEqual({ ready: true });
  });
});

describe('vehicleChangeDecisionMessage', () => {
  it('maps server codes to admin copy and never echoes raw codes', () => {
    expect(vehicleChangeDecisionMessage('REJECTION_REASON_REQUIRED')).toContain('reason');
    expect(vehicleChangeDecisionMessage('SOMETHING_NEW')).toBe('Could not save the decision. Please try again.');
  });
});
