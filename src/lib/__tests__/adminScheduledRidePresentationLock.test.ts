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
      driver_id: null,
      confirmed_driver_id: null,
    });
    expect(p.statusLabel).toBe('Held');
    expect(p.driverKind).toBe('unassigned');
    expect(p.belongsOnLiveScheduledBoard).toBe(true);
  });

  it('AVAILABLE → Status Available + Driver Unassigned', () => {
    const p = resolveAdminScheduledRidePresentation({
      scheduled_status: 'scheduled',
      status: 'scheduled',
      scheduled_broadcast_at: '2026-09-23T10:00:00Z',
      driver_id: null,
      confirmed_driver_id: null,
    });
    expect(p.statusLabel).toBe('Available');
    expect(p.driverKind).toBe('unassigned');
  });

  it('PRE-CONFIRMED → Pre-confirmed + confirmed driver name (not Unassigned / not Driver Assigned)', () => {
    const p = resolveAdminScheduledRidePresentation({
      scheduled_status: 'driver_assigned',
      status: 'scheduled',
      driver_id: null,
      confirmed_driver_id: 'conf-1',
      confirmed_driver: { first_name: 'Ahmed', last_name: 'Osman' },
    });
    expect(p.statusLabel).toBe('Pre-confirmed');
    expect(p.statusKey).toBe('pre_confirmed');
    expect(p.driverKind).toBe('pre_confirmed');
    expect(p.driverDisplayName).toBe('Ahmed Osman');
    expect(p.driverBadge).toBe('PRE-CONFIRMED');
    // FORBIDDEN contradictions
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

  it('Finding Driver when activated/broadcasting with no accepted driver', () => {
    const p = resolveAdminScheduledRidePresentation({
      scheduled_status: 'converted_to_instant',
      status: 'searching',
      driver_id: null,
      confirmed_driver_id: null,
    });
    expect(p.statusLabel).toBe('Finding Driver');
    expect(p.driverKind).toBe('unassigned');
  });

  it('ACTIVE ACCEPTED → Driver Assigned + name; not Pending', () => {
    const p = resolveAdminScheduledRidePresentation({
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
      driver_id: null,
      confirmed_driver_id: null,
    };
    const a = resolveAdminScheduledRidePresentation(trip);
    const b = resolveAdminScheduledRidePresentation(trip);
    expect(a).toEqual(b);
  });
});
