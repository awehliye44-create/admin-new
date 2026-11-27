/**
 * A-1 / A-2 — Admin Active Trips cancel UX + Realtime (Owner safety rules).
 *
 * Immediate pending feedback: OK while Edge runs.
 * Optimistic authoritative cancellation: PROHIBITED — board mutate only after
 * Edge success:true (dispose path already completed server-side).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  decideAdminTripsRealtimeApply,
  isAdminCancelEdgeConfirmed,
} from '@/lib/adminActiveTripsRealtimeSSOT';

const ROOT = join(__dirname, '../..');
const SRC = readFileSync(join(ROOT, 'pages/ActiveTrips.tsx'), 'utf8');

describe('Admin Active Trips A-1 cancel — confirmed after Edge only', () => {
  it('still cancels via admin-trip-actions Edge (dispose path)', () => {
    expect(SRC).toMatch(/functions\.invoke\(\s*['"]admin-trip-actions['"]/);
    expect(SRC).toMatch(/action:\s*['"]cancel['"]/);
    expect(SRC).toContain('isAdminCancelEdgeConfirmed');
  });

  it('mutates board only after confirmed_after_edge (never pre-Edge)', () => {
    expect(SRC).toMatch(/cancel_ux:\s*['"]confirmed_after_edge['"]/);
    expect(SRC).not.toMatch(/optimistic_after_edge/);
    const edgeIdx = SRC.indexOf("action: 'cancel'");
    const gateIdx = SRC.indexOf('isAdminCancelEdgeConfirmed(cancelResult)');
    const confirmedIdx = SRC.indexOf("cancel_ux: 'confirmed_after_edge'");
    const broadcastLoopIdx = SRC.indexOf('trip_broadcast_${tripId}');
    expect(edgeIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeGreaterThan(edgeIdx);
    expect(confirmedIdx).toBeGreaterThan(gateIdx);
    expect(broadcastLoopIdx).toBeGreaterThan(confirmedIdx);
    // Board remove must sit after the Edge confirm gate.
    const removeIdx = SRC.indexOf('setTrips((prev) => prev.filter((t) => t.id !== tripId))');
    expect(removeIdx).toBeGreaterThan(gateIdx);
  });

  it('guards duplicate cancel and reconciles on rejection/timeout', () => {
    expect(SRC).toContain('cancelInFlightRef');
    expect(SRC).toMatch(/if \(cancelInFlightRef\.current \|\| isSaving\) return/);
    expect(SRC).toContain('CRITICAL_BUTTON_TIMEOUT_MESSAGE');
    // Timeout clears pending only — must not set cancelled toast.
    const timeoutBlock = SRC.slice(
      SRC.indexOf('onTimeout: () => {'),
      SRC.indexOf('onTimeout: () => {') + 400,
    );
    expect(timeoutBlock).toContain('fetchData(true)');
    expect(timeoutBlock).not.toContain("toast.success");
  });

  it('still publishes MK-260704-001 dual-channel trip_updated (non-blocking)', () => {
    expect(SRC).toMatch(/trip:\$\{tripId\}/);
    expect(SRC).toMatch(/trip_broadcast_\$\{tripId\}/);
    expect(SRC).toMatch(/event:\s*['"]trip_updated['"]/);
    expect(SRC).toMatch(/void \(async \(\) => \{/);
  });
});

describe('isAdminCancelEdgeConfirmed', () => {
  it('requires explicit success:true', () => {
    expect(isAdminCancelEdgeConfirmed({ success: true }).confirmed).toBe(true);
    expect(isAdminCancelEdgeConfirmed(null).confirmed).toBe(false);
    expect(isAdminCancelEdgeConfirmed({}).confirmed).toBe(false);
    expect(isAdminCancelEdgeConfirmed({ success: false, error: 'x' }).confirmed).toBe(
      false,
    );
    expect(
      isAdminCancelEdgeConfirmed({
        success: true,
        result: { success: false, error: 'nested' },
      }).confirmed,
    ).toBe(false);
  });
});

describe('Admin Active Trips A-2 Realtime incremental', () => {
  it('wires SSOT + reconnect reconcile', () => {
    expect(SRC).toContain('decideAdminTripsRealtimeApply');
    expect(SRC).toContain('void fetchData(true)');
    expect(SRC).toMatch(/table:\s*['"]trip_stops['"]/);
    expect(SRC).toMatch(/table:\s*['"]trip_change_requests['"]/);
  });

  it('removes terminal status; never invents unknown active rows', () => {
    const known = new Set(['t1']);
    expect(
      decideAdminTripsRealtimeApply(
        { eventType: 'UPDATE', new: { id: 't1', status: 'cancelled' } },
        known,
      ),
    ).toEqual({ kind: 'remove', tripId: 't1' });

    expect(
      decideAdminTripsRealtimeApply(
        { eventType: 'DELETE', old: { id: 't1' } },
        known,
      ),
    ).toEqual({ kind: 'remove', tripId: 't1' });

    // Stale/out-of-order active UPDATE for unknown id → full refresh (not invent).
    expect(
      decideAdminTripsRealtimeApply(
        {
          eventType: 'UPDATE',
          new: { id: 't2', status: 'in_progress', passenger_name: 'A' },
        },
        known,
      ),
    ).toEqual({ kind: 'full_refresh' });
  });

  it('patches known active rows', () => {
    const known = new Set(['t1']);
    const d = decideAdminTripsRealtimeApply(
      {
        eventType: 'UPDATE',
        new: {
          id: 't1',
          status: 'en_route',
          passenger_name: 'Pat',
          driver_id: null,
        },
      },
      known,
    );
    expect(d.kind).toBe('patch');
    if (d.kind === 'patch') {
      expect(d.fields.status).toBe('en_route');
      expect(d.fields.passenger_name).toBe('Pat');
      expect(d.fields.driver_id).toBeNull();
    }
  });
});
