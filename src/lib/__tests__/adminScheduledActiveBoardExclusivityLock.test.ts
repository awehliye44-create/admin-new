import { describe, expect, it } from 'vitest';
import {
  belongsOnLiveAdminActiveBoard,
  belongsOnLiveAdminScheduledBoard,
  isCanonicalActiveAssignedLifecycle,
} from '../adminScheduledBoardMembership';
import { resolveAdminScheduledRidePresentation } from '../adminScheduledRidePresentation';

function boards(input: {
  is_scheduled?: boolean | null;
  status?: string | null;
  scheduled_status?: string | null;
  driver_id?: string | null;
  confirmed_driver_id?: string | null;
}) {
  const scheduled = belongsOnLiveAdminScheduledBoard(input);
  const active = belongsOnLiveAdminActiveBoard(input);
  return { scheduled, active, both: scheduled && active };
}

describe('Admin Scheduled ↔ Active mutual exclusivity', () => {
  it('HELD: Scheduled YES / Active NO', () => {
    const b = boards({
      is_scheduled: true,
      scheduled_status: 'admin_held',
      status: 'scheduled',
      driver_id: null,
    });
    expect(b).toEqual({ scheduled: true, active: false, both: false });
  });

  it('AVAILABLE IN SCHEDULED JOBS: Scheduled YES / Active NO', () => {
    const b = boards({
      is_scheduled: true,
      scheduled_status: 'scheduled',
      status: 'scheduled',
      driver_id: null,
    });
    expect(b).toEqual({ scheduled: true, active: false, both: false });
  });

  it('PRE-CONFIRMED: Scheduled YES / Active NO', () => {
    const b = boards({
      is_scheduled: true,
      scheduled_status: 'driver_assigned',
      status: 'scheduled',
      driver_id: null,
      confirmed_driver_id: 'conf-1',
    });
    expect(b).toEqual({ scheduled: true, active: false, both: false });
  });

  it('ACTIVATION NRO PENDING (searching, no driver): Scheduled YES / Active NO', () => {
    const b = boards({
      is_scheduled: true,
      scheduled_status: 'converted_to_instant',
      status: 'searching',
      driver_id: null,
    });
    expect(b).toEqual({ scheduled: true, active: false, both: false });
  });

  it('ACTIVATION NRO PENDING (offered, no driver): Scheduled YES / Active NO', () => {
    const b = boards({
      is_scheduled: true,
      scheduled_status: 'awaiting_activation_accept',
      status: 'offered',
      driver_id: null,
      confirmed_driver_id: 'conf-1',
    });
    expect(b).toEqual({ scheduled: true, active: false, both: false });
  });

  it('NRO ACCEPTED: Scheduled NO / Active YES', () => {
    const b = boards({
      is_scheduled: true,
      scheduled_status: 'converted_to_instant',
      status: 'accepted',
      driver_id: 'drv-1',
    });
    expect(b).toEqual({ scheduled: false, active: true, both: false });
  });

  it('EN_ROUTE_TO_PICKUP: Scheduled NO / Active YES', () => {
    const b = boards({
      is_scheduled: true,
      status: 'en_route_to_pickup',
      scheduled_status: 'converted_to_instant',
      driver_id: 'drv-1',
    });
    expect(b).toEqual({ scheduled: false, active: true, both: false });
  });

  it('ARRIVED: Scheduled NO / Active YES', () => {
    const b = boards({
      is_scheduled: true,
      status: 'arrived',
      driver_id: 'drv-1',
    });
    expect(b).toEqual({ scheduled: false, active: true, both: false });
  });

  it('IN_PROGRESS: Scheduled NO / Active YES', () => {
    const b = boards({
      is_scheduled: true,
      status: 'in_progress',
      scheduled_status: 'converted_to_instant',
      driver_id: 'drv-1',
    });
    expect(b).toEqual({ scheduled: false, active: true, both: false });
  });

  it('COMPLETED: Scheduled NO / Active NO', () => {
    const b = boards({
      is_scheduled: true,
      status: 'completed',
      driver_id: 'drv-1',
    });
    expect(b).toEqual({ scheduled: false, active: false, both: false });
  });

  it('EXPIRED: Scheduled NO / Active NO', () => {
    const b = boards({
      is_scheduled: true,
      status: 'expired_no_driver',
      scheduled_status: 'no_driver_found',
      driver_id: null,
    });
    expect(b).toEqual({ scheduled: false, active: false, both: false });
  });

  it('CANCELLED: Scheduled NO / Active NO', () => {
    const b = boards({
      is_scheduled: true,
      status: 'cancelled',
      scheduled_status: 'cancelled',
      driver_id: null,
    });
    expect(b).toEqual({ scheduled: false, active: false, both: false });
  });

  it('MK-260923-010 shape: converted_to_instant + in_progress never on Scheduled / never Pending', () => {
    const input = {
      is_scheduled: true as const,
      scheduled_status: 'converted_to_instant',
      status: 'in_progress',
      driver_id: '56136f5f-1a3a-4a14-bb23-439b3951415a',
      driver: { first_name: 'Ahmed Osman', last_name: 'Wehliye' },
    };
    expect(belongsOnLiveAdminScheduledBoard(input)).toBe(false);
    expect(belongsOnLiveAdminActiveBoard(input)).toBe(true);
    const p = resolveAdminScheduledRidePresentation(input);
    expect(p.statusLabel).not.toBe('Pending');
    expect(p.belongsOnLiveScheduledBoard).toBe(false);
  });

  it('confirmed_driver_id set + driver_id null → Pre-confirmed, never Unassigned', () => {
    const p = resolveAdminScheduledRidePresentation({
      is_scheduled: true,
      confirmed_driver_id: 'conf-1',
      driver_id: null,
      scheduled_status: 'driver_assigned',
      status: 'scheduled',
      confirmed_driver: { first_name: 'Ahmed', last_name: 'Osman' },
    });
    expect(p.driverKind).toBe('pre_confirmed');
    expect(p.driverKind).not.toBe('unassigned');
    expect(p.statusLabel).toBe('Pre-confirmed');
  });

  it('driver_id set + active status → never Pending', () => {
    const p = resolveAdminScheduledRidePresentation({
      driver_id: 'drv-1',
      status: 'accepted',
      scheduled_status: 'converted_to_instant',
      driver: { first_name: 'A', last_name: 'B' },
    });
    expect(p.statusLabel).not.toBe('Pending');
  });

  it('does not invent Pending for unmapped combinations', () => {
    const p = resolveAdminScheduledRidePresentation({
      is_scheduled: true,
      scheduled_status: 'weird_future_status',
      status: 'also_weird',
      driver_id: null,
      confirmed_driver_id: null,
    });
    expect(p.statusLabel).not.toBe('Pending');
    expect(p.unmapped).toBe(true);
    expect(p.statusKey).toBe('unmapped');
  });

  it('is_scheduled provenance alone never places trip on Active', () => {
    expect(
      belongsOnLiveAdminActiveBoard({
        is_scheduled: true,
        status: 'scheduled',
        scheduled_status: 'admin_held',
        driver_id: null,
      }),
    ).toBe(false);
  });

  it('active assigned lifecycle uses ACTIVE_TRIP_DB_STATUSES subset', () => {
    expect(isCanonicalActiveAssignedLifecycle('in_progress')).toBe(true);
    expect(isCanonicalActiveAssignedLifecycle('accepted')).toBe(true);
    expect(isCanonicalActiveAssignedLifecycle('searching')).toBe(false);
    expect(isCanonicalActiveAssignedLifecycle('offered')).toBe(false);
  });
});
