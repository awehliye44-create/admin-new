import { describe, expect, it } from 'vitest';
import {
  buildAdminScheduledOpsSnapshot,
  buildAdminScheduledWorkflowEvents,
  formatCountdownLabel,
  resolveDepartureAckCountdownSeconds,
  resolveManualInterventionRequired,
  resolveOperationalReadiness,
} from '../adminScheduledRideMonitoring';
import { SCHEDULED_RIDES_EDGE_ACTION_PERMISSION } from '../../../supabase/functions/_shared/scheduledRidesActionPermissionsSSOT';

describe('adminScheduledRideMonitoring — Phase 6', () => {
  it('formats remaining ack countdown from deadline', () => {
    const now = Date.parse('2026-11-12T12:00:00.000Z');
    const seconds = resolveDepartureAckCountdownSeconds(
      {
        scheduled_ack_status: 'pending',
        scheduled_ack_deadline_at: '2026-11-12T12:00:30.000Z',
      },
      now,
    );
    expect(seconds).toBe(30);
    expect(formatCountdownLabel(seconds)).toBe('30s');
    expect(
      resolveDepartureAckCountdownSeconds(
        { scheduled_ack_status: 'acknowledged', scheduled_ack_deadline_at: '2026-11-12T12:00:30.000Z' },
        now,
      ),
    ).toBeNull();
  });

  it('does not require intervention for ack pending or timeout while rematching', () => {
    expect(
      resolveManualInterventionRequired({
        scheduled_ack_status: 'pending',
        scheduled_status: 'awaiting_activation_accept',
      }),
    ).toBe(false);
    expect(
      resolveManualInterventionRequired({
        scheduled_ack_status: 'timed_out',
        scheduled_status: 'converted_to_instant',
        status: 'searching',
      }),
    ).toBe(false);
  });

  it('requires intervention for payment / airport / exhaustion / stranded timeout', () => {
    expect(
      resolveManualInterventionRequired({ scheduled_hold_reason: 'payment_gate' }),
    ).toBe(true);
    expect(
      resolveManualInterventionRequired({ scheduled_hold_reason: 'airport_pricing' }),
    ).toBe(true);
    expect(
      resolveManualInterventionRequired({ scheduled_hold_reason: 'publication_exhausted' }),
    ).toBe(true);
    expect(
      resolveManualInterventionRequired({
        scheduled_ack_status: 'timed_out',
        scheduled_status: 'driver_assigned',
        status: 'scheduled',
      }),
    ).toBe(true);
    expect(
      resolveManualInterventionRequired({ status: 'expired_no_driver', scheduled_status: 'no_driver_found' }),
    ).toBe(true);
  });

  it('surfaces payment and airport readiness without sensitive card details', () => {
    const ready = resolveOperationalReadiness({
      payment_method: 'card',
      payment_state: 'authorised',
      airport_charge_pence: 350,
    });
    expect(ready.paymentOk).toBe(true);
    expect(ready.paymentLabel.toLowerCase()).not.toMatch(/cvv|pan|secret|token/);
    expect(ready.airportLabel).toContain('£3.50');

    const blocked = resolveOperationalReadiness({
      scheduled_hold_reason: 'airport_pricing',
      scheduled_status: 'payment_gate_blocked',
    });
    expect(blocked.airportOk).toBe(false);
    expect(blocked.paymentOk).toBe(false);
  });

  it('builds workflow events from authoritative trip columns', () => {
    const events = buildAdminScheduledWorkflowEvents({
      scheduled_broadcast_at: '2026-11-12T10:00:00Z',
      confirmed_driver_id: 'drv-1',
      scheduled_jit_activate_at: '2026-11-12T11:50:00Z',
      scheduled_ack_armed_at: '2026-11-12T11:55:00Z',
      scheduled_ack_status: 'timed_out',
      scheduled_ack_resolved_at: '2026-11-12T11:55:45Z',
      scheduled_status: 'converted_to_instant',
      status: 'searching',
      excluded_driver_ids: ['drv-1'],
    });
    const keys = events.map((e) => e.key);
    expect(keys).toContain('published');
    expect(keys).toContain('accepted');
    expect(keys).toContain('jit');
    expect(keys).toContain('armed');
    expect(keys).toContain('timeout');
    expect(keys).toContain('instant');
    expect(keys).toContain('search');
    expect(keys).toContain('excluded');
  });

  it('ops snapshot exposes ack countdown, JIT deadline, replacement search', () => {
    const now = Date.parse('2026-11-12T12:00:20.000Z');
    const snap = buildAdminScheduledOpsSnapshot(
      {
        scheduled_at: '2026-11-12T12:30:00.000Z',
        scheduled_jit_activate_at: '2026-11-12T12:10:00.000Z',
        scheduled_jit_eta_minutes: 12.4,
        scheduled_ack_status: 'pending',
        scheduled_ack_deadline_at: '2026-11-12T12:00:45.000Z',
        confirmed_driver_id: 'conf-1',
        scheduled_status: 'awaiting_activation_accept',
      },
      now,
    );
    expect(snap.ackCountdownLabel).toBe('25s');
    expect(snap.driverToPickupEtaLabel).toBe('12 min');
    expect(snap.jitDeadlineLabel).toContain('2026-11-12');
    expect(snap.replacementSearchLabel).toBeNull();

    const rematch = buildAdminScheduledOpsSnapshot({
      scheduled_status: 'converted_to_instant',
      status: 'searching',
    });
    expect(rematch.replacementSearchLabel).toMatch(/replacement/i);
  });

  it('retains Phase 3 emergency action permission map (no parallel RBAC)', () => {
    expect(SCHEDULED_RIDES_EDGE_ACTION_PERMISSION.make_available_now).toBe(
      'scheduled_rides.make_available',
    );
    expect(SCHEDULED_RIDES_EDGE_ACTION_PERMISSION.assign_now).toBe('scheduled_rides.assign');
    expect(SCHEDULED_RIDES_EDGE_ACTION_PERMISSION.broadcast_now).toBe(
      'scheduled_rides.broadcast',
    );
    expect(SCHEDULED_RIDES_EDGE_ACTION_PERMISSION.hold_exceptional).toBe(
      'scheduled_rides.hold',
    );
    expect(SCHEDULED_RIDES_EDGE_ACTION_PERMISSION.cancel_pending_release).toBe(
      'scheduled_rides.cancel_pending',
    );
    expect(SCHEDULED_RIDES_EDGE_ACTION_PERMISSION.cancel_ride).toBe(
      'scheduled_rides.cancel_ride',
    );
  });
});
