/**
 * Document history version chains — group by driver + type + vehicle;
 * current vs retired; never mix vehicles or drop history rows.
 */
import { describe, expect, it } from 'vitest';
import {
  documentVersionChainKey,
  groupDocumentsIntoVersionChains,
  versionLifecycleLabel,
  type DocumentVersionRow,
} from '../documentVersionChains';

function doc(partial: Partial<DocumentVersionRow> & Pick<DocumentVersionRow, 'id'>): DocumentVersionRow {
  return {
    driver_id: 'drv-1',
    document_type: 'vehicle_insurance',
    document_name: 'Insurance',
    status: 'approved',
    expiry_date: null,
    notes: null,
    rejection_reason: null,
    reviewed_at: null,
    created_at: '2026-01-01T00:00:00Z',
    is_current: true,
    superseded_by: null,
    vehicle_id: 'veh-1',
    ...partial,
  };
}

describe('documentVersionChains', () => {
  it('groups by driver + document type + vehicle and keeps current vs retired', () => {
    const rows = [
      doc({
        id: 'v2',
        created_at: '2026-03-01T00:00:00Z',
        is_current: true,
        status: 'pending',
      }),
      doc({
        id: 'v1',
        created_at: '2026-01-01T00:00:00Z',
        is_current: false,
        superseded_by: 'v2',
        status: 'approved',
        rejection_reason: null,
        reviewed_at: '2026-01-02T00:00:00Z',
        reviewerId: 'staff-1',
      }),
    ];
    const chains = groupDocumentsIntoVersionChains(rows);
    expect(chains).toHaveLength(1);
    expect(chains[0].key).toBe(documentVersionChainKey('drv-1', 'vehicle_insurance', 'veh-1'));
    expect(chains[0].versions.map((v) => v.id)).toEqual(['v2', 'v1']);
    expect(chains[0].current?.id).toBe('v2');
    expect(versionLifecycleLabel(chains[0].versions[0])).toBe('Current');
    expect(versionLifecycleLabel(chains[0].versions[1])).toBe('Retired');
  });

  it('does not mix driver-level docs with vehicle docs or another vehicle', () => {
    const rows = [
      doc({ id: 'a', vehicle_id: 'veh-1' }),
      doc({ id: 'b', vehicle_id: 'veh-2' }),
      doc({ id: 'c', vehicle_id: null, document_type: 'driving_licence' }),
    ];
    const chains = groupDocumentsIntoVersionChains(rows);
    expect(chains).toHaveLength(3);
    const keys = new Set(chains.map((c) => c.key));
    expect(keys.has(documentVersionChainKey('drv-1', 'vehicle_insurance', 'veh-1'))).toBe(true);
    expect(keys.has(documentVersionChainKey('drv-1', 'vehicle_insurance', 'veh-2'))).toBe(true);
    expect(keys.has(documentVersionChainKey('drv-1', 'driving_licence', null))).toBe(true);
  });

  it('preserves all versions in a chain (recovery: history never dropped)', () => {
    const rows = [
      doc({ id: 'c', created_at: '2026-03-01T00:00:00Z', is_current: true }),
      doc({ id: 'b', created_at: '2026-02-01T00:00:00Z', is_current: false, superseded_by: 'c' }),
      doc({ id: 'a', created_at: '2026-01-01T00:00:00Z', is_current: false, superseded_by: 'b' }),
    ];
    const [chain] = groupDocumentsIntoVersionChains(rows);
    expect(chain.versions).toHaveLength(3);
    expect(chain.versions.map((v) => v.id)).toEqual(['c', 'b', 'a']);
  });
});
