/**
 * A-1 / A-2 — Admin Active Trips cancel UX + Realtime patch (non-financial).
 * Lock: Edge cancel remains required; broadcasts still fire; full board refetch
 * is not awaited for cancel success UX; trip Realtime patches/removes when possible.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../..');
const SRC = readFileSync(join(ROOT, 'pages/ActiveTrips.tsx'), 'utf8');

describe('Admin Active Trips A-1 cancel responsiveness', () => {
  it('still cancels via admin-trip-actions Edge (dispose path)', () => {
    expect(SRC).toMatch(/functions\.invoke\(\s*['"]admin-trip-actions['"]/);
    expect(SRC).toMatch(/action:\s*['"]cancel['"]/);
  });

  it('optimistically removes the trip and closes before awaiting broadcasts', () => {
    expect(SRC).toMatch(/cancel_ux:\s*['"]optimistic_after_edge['"]/);
    expect(SRC).toMatch(/setTrips\(\(prev\) => prev\.filter/);
    const edgeIdx = SRC.indexOf("action: 'cancel'");
    const optimisticIdx = SRC.indexOf("cancel_ux: 'optimistic_after_edge'");
    const broadcastLoopIdx = SRC.indexOf('trip_broadcast_${tripId}');
    expect(edgeIdx).toBeGreaterThan(-1);
    expect(optimisticIdx).toBeGreaterThan(edgeIdx);
    expect(broadcastLoopIdx).toBeGreaterThan(optimisticIdx);
  });

  it('still publishes MK-260704-001 dual-channel trip_updated (non-blocking)', () => {
    expect(SRC).toMatch(/trip:\$\{tripId\}/);
    expect(SRC).toMatch(/trip_broadcast_\$\{tripId\}/);
    expect(SRC).toMatch(/event:\s*['"]trip_updated['"]/);
    expect(SRC).toMatch(/void \(async \(\) => \{/);
  });
});

describe('Admin Active Trips A-2 Realtime incremental', () => {
  it('handles trips Realtime with payload patch/remove before full refresh', () => {
    expect(SRC).toMatch(/onTripsRealtime/);
    expect(SRC).toMatch(/isActiveTripDbStatus/);
    expect(SRC).toMatch(/eventType === 'DELETE'/);
  });

  it('keeps stop / change_request full refresh path', () => {
    expect(SRC).toMatch(/table:\s*['"]trip_stops['"]/);
    expect(SRC).toMatch(/table:\s*['"]trip_change_requests['"]/);
  });
});
