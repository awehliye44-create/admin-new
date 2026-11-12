import { describe, expect, it } from 'vitest';
import {
  belongsOnLiveAdminScheduledBoard,
  resolveAdminScheduledRidePresentation,
  resolveAdminScheduledTimeCue,
} from '../adminScheduledRidePresentation';

describe('adminScheduledRidePresentation — ownership SSOT', () => {
  it('HELD → Status Held + Driver Unassigned', () => {
    const p = resolveAdminScheduledRidePresentation({
      scheduled_status: 'admin_held',
      status: 'scheduled',
      scheduled_broadcast_at: '2026-09-23T10:00:00Z',
      driver_id: null,
      confirmed_driver_id: null,
    });
    expect(p.statusLabel).toBe('Held');
    expect(p.driverKind).toBe('unassigned');
    expect(p.belongsOnLiveScheduledBoard).toBe(true);
  });

  it('unpublished scheduled → Awaiting publication', () => {
    const p = resolveAdminScheduledRidePresentation({
      scheduled_status: 'scheduled',
      status: 'scheduled',
      driver_id: null,
      confirmed_driver_id: null,
    });
    expect(p.statusKey).toBe('awaiting_publication');
    expect(p.statusLabel).toBe('Awaiting publication');
  });

  it('AVAILABLE / Requested → published scheduled + Driver Unassigned', () => {
    const p = resolveAdminScheduledRidePresentation({
      scheduled_status: 'scheduled',
      status: 'scheduled',
      scheduled_broadcast_at: '2026-09-23T10:00:00Z',
      driver_id: null,
      confirmed_driver_id: null,
    });
    expect(p.statusKey).toBe('available');
    expect(p.statusLabel).toBe('Requested');
    expect(p.driverKind).toBe('unassigned');
  });

  it('payment_gate_blocked → Payment blocked on Scheduled board', () => {
    const p = resolveAdminScheduledRidePresentation({
      scheduled_status: 'payment_gate_blocked',
      status: 'scheduled',
      scheduled_broadcast_at: '2026-09-23T10:00:00Z',
      driver_id: null,
      confirmed_driver_id: null,
    });
    expect(p.statusKey).toBe('payment_blocked');
    expect(p.statusLabel).toBe('Payment blocked');
    expect(p.belongsOnLiveScheduledBoard).toBe(true);
    expect(p.needsAttention).toBe(true);
  });

  it('PRE-CONFIRMED → Pre-confirmed + confirmed driver name (not Unassigned / not Driver Assigned)', () => {
    const p = resolveAdminScheduledRidePresentation({
      scheduled_status: 'driver_assigned',
      status: 'scheduled',
      driver_id: null,
      confirmed_driver_id: 'conf-1',
      confirmed_driver: { first_name: 'Ahmed', last_name: 'Osman' },
    });
    expect(p.statusLabel).toBe('Confirmed');
    expect(p.statusKey).toBe('pre_confirmed');
    expect(p.driverKind).toBe('pre_confirmed');
    expect(p.driverDisplayName).toBe('Ahmed Osman');
    expect(p.driverBadge).toBe('PRE-CONFIRMED');
    expect(p.statusLabel).not.toBe('Driver Assigned');
    expect(p.driverKind).not.toBe('unassigned');
  });

  it('FORBIDDEN: confirmed_driver_id set must never present Driver Unassigned', () => {
    const p = resolveAdminScheduledRidePresentation({
      confirmed_driver_id: 'conf-1',
      driver_id: null,
      scheduled_status: 'driver_assigned',
      status: 'scheduled',
      confirmed_driver: { first_name: 'Abdifitah', last_name: 'Ibrahim' },
    });
    expect(p.driverKind).not.toBe('unassigned');
    expect(p.driverDisplayName).toBe('Abdifitah Ibrahim');
  });

  it('FORBIDDEN: Status Driver Assigned + Driver Unassigned', () => {
    const p = resolveAdminScheduledRidePresentation({
      scheduled_status: 'driver_assigned',
      status: 'scheduled',
      driver_id: null,
      confirmed_driver_id: 'conf-1',
      confirmed_driver: { first_name: 'X', last_name: 'Y' },
    });
    expect(!(p.statusLabel === 'Driver Assigned' && p.driverKind === 'unassigned')).toBe(true);
  });

  it('Searching when activated/broadcasting with no accepted driver', () => {
    const p = resolveAdminScheduledRidePresentation({
      scheduled_status: 'converted_to_instant',
      status: 'searching',
      driver_id: null,
      confirmed_driver_id: null,
    });
    expect(p.statusKey).toBe('finding_driver');
    expect(p.statusLabel).toBe('Searching');
    expect(p.driverKind).toBe('unassigned');
    // Automatic rematch — not a manual intervention requirement.
    expect(p.needsAttention).toBe(false);
  });

  it('Phase 5/6: ack pending is monitor-only; never Heading to pickup', () => {
    const pending = resolveAdminScheduledRidePresentation({
      scheduled_status: 'awaiting_activation_accept',
      status: 'scheduled',
      confirmed_driver_id: 'conf-1',
      scheduled_ack_status: 'pending',
      confirmed_driver: { first_name: 'A', last_name: 'B' },
    });
    expect(pending.statusKey).toBe('alert_pending');
    expect(pending.statusLabel).toBe('Awaiting departure ack');
    expect(pending.statusLabel.toLowerCase()).not.toContain('heading');
    expect(pending.needsAttention).toBe(false);

    const timedOutRecovering = resolveAdminScheduledRidePresentation({
      scheduled_status: 'converted_to_instant',
      status: 'searching',
      confirmed_driver_id: null,
      scheduled_ack_status: 'timed_out',
    });
    expect(timedOutRecovering.statusKey).toBe('alert_timeout');
    expect(timedOutRecovering.needsAttention).toBe(false);
  });

  it('FORBIDDEN: Heading to pickup before successful departure acknowledgement', () => {
    const withoutAck = resolveAdminScheduledRidePresentation({
      scheduled_status: 'converted_to_instant',
      status: 'en_route_to_pickup',
      driver_id: 'drv-1',
      scheduled_ack_status: null,
      driver: { first_name: 'A', last_name: 'B' },
    });
    expect(withoutAck.statusLabel.toLowerCase()).not.toContain('heading');
    expect(withoutAck.statusLabel).toBe('Driver Assigned');

    const withAck = resolveAdminScheduledRidePresentation({
      scheduled_status: 'converted_to_instant',
      status: 'en_route_to_pickup',
      driver_id: 'drv-1',
      scheduled_ack_status: 'acknowledged',
      driver: { first_name: 'A', last_name: 'B' },
    });
    expect(withAck.statusKey).toBe('heading_to_pickup');
    expect(withAck.statusLabel).toBe('Heading to pickup');
  });

  it('JIT pending when confirmed awaiting activation without ack', () => {
    const p = resolveAdminScheduledRidePresentation({
      scheduled_status: 'awaiting_activation_accept',
      status: 'scheduled',
      confirmed_driver_id: 'conf-1',
      confirmed_driver: { first_name: 'A', last_name: 'B' },
    });
    expect(p.statusKey).toBe('jit_pending');
    expect(p.statusLabel).toBe('JIT pending');
  });

  it('ACTIVE ACCEPTED → Driver Assigned + name; not Pending; off Scheduled board', () => {
    const p = resolveAdminScheduledRidePresentation({
      is_scheduled: true,
      scheduled_status: 'converted_to_instant',
      status: 'en_route_to_pickup',
      driver_id: 'drv-1',
      confirmed_driver_id: null,
      driver: { first_name: 'Abdifitah', last_name: 'Ibrahim' },
    });
    expect(p.statusLabel).toBe('Driver Assigned');
    expect(p.statusLabel).not.toBe('Pending');
    expect(p.driverKind).toBe('assigned');
    expect(p.driverDisplayName).toBe('Abdifitah Ibrahim');
    expect(p.belongsOnLiveScheduledBoard).toBe(false);
  });

  it('in_progress without presentation on Scheduled board (lifecycle exclusivity)', () => {
    expect(
      belongsOnLiveAdminScheduledBoard({
        is_scheduled: true,
        status: 'in_progress',
        scheduled_status: 'converted_to_instant',
        driver_id: 'drv-1',
      }),
    ).toBe(false);
  });

  it('FORBIDDEN: driver_id set + Status Pending', () => {
    const p = resolveAdminScheduledRidePresentation({
      driver_id: 'drv-1',
      status: 'accepted',
      scheduled_status: 'converted_to_instant',
      driver: { first_name: 'A', last_name: 'B' },
    });
    expect(p.statusLabel).not.toBe('Pending');
  });

  it('EXPIRED / CANCELLED off live board', () => {
    expect(
      belongsOnLiveAdminScheduledBoard({
        status: 'expired_no_driver',
        scheduled_status: 'no_driver_found',
        driver_id: null,
      }),
    ).toBe(false);
    expect(
      belongsOnLiveAdminScheduledBoard({
        status: 'cancelled',
        scheduled_status: 'cancelled',
        driver_id: null,
      }),
    ).toBe(false);
    const expired = resolveAdminScheduledRidePresentation({
      status: 'expired_no_driver',
      scheduled_status: 'no_driver_found',
      driver_id: null,
    });
    expect(expired.statusLabel).toBe('Expired');
    expect(expired.driverKind).toBe('unassigned');
    expect(expired.needsAttention).toBe(true);
  });

  it('never invents Overdue lifecycle label', () => {
    const cue = resolveAdminScheduledTimeCue('2020-01-01T00:00:00Z');
    expect(cue.label).not.toBe('Overdue' as never);
    expect(['Today', 'Tomorrow', 'Upcoming', 'No Date']).toContain(cue.label);
  });

  it('one presentation per trip input (no duplicate projection keys)', () => {
    const trip = {
      id: 'trip-uuid-1',
      scheduled_status: 'admin_held',
      status: 'scheduled',
      scheduled_broadcast_at: '2026-09-23T10:00:00Z',
      driver_id: null,
      confirmed_driver_id: null,
    };
    const a = resolveAdminScheduledRidePresentation(trip);
    const b = resolveAdminScheduledRidePresentation(trip);
    expect(a).toEqual(b);
  });
});
