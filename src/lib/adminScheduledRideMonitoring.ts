/**
 * Phase 6 — Admin Scheduled Rides monitoring helpers.
 * Presentation-only: derives ops visibility from authoritative trip columns.
 * Does not invent a second event log or status store.
 */

export type AdminScheduledMonitoringTrip = {
  id?: string | null;
  status?: string | null;
  scheduled_status?: string | null;
  scheduled_broadcast_at?: string | null;
  scheduled_at?: string | null;
  scheduled_hold_reason?: string | null;
  scheduled_publish_attempts?: number | null;
  scheduled_ack_status?: string | null;
  scheduled_ack_deadline_at?: string | null;
  scheduled_ack_armed_at?: string | null;
  scheduled_ack_acknowledged_at?: string | null;
  scheduled_ack_resolved_at?: string | null;
  scheduled_ack_resolution_reason?: string | null;
  confirmed_driver_id?: string | null;
  driver_id?: string | null;
  excluded_driver_ids?: string[] | null;
  pending_release_kind?: string | null;
  pending_release_at?: string | null;
  payment_state?: string | null;
  payment_method?: string | null;
  estimated_duration_minutes?: number | null;
  airport_charge_pence?: number | null;
  scheduled_jit_activate_at?: string | null;
  scheduled_jit_eta_minutes?: number | null;
  scheduled_jit_eta_observed_at?: string | null;
  scheduled_jit_activated_at?: string | null;
};

export type AdminScheduledWorkflowEvent = {
  key: string;
  label: string;
  at: string | null;
  tone: 'neutral' | 'ok' | 'warn' | 'bad';
};

export type AdminScheduledReadiness = {
  paymentLabel: string;
  paymentOk: boolean;
  airportLabel: string;
  airportOk: boolean;
};

function norm(value: string | null | undefined): string {
  return String(value ?? '').trim().toLowerCase();
}

function nonEmpty(value: string | null | undefined): string | null {
  const v = String(value ?? '').trim();
  return v.length > 0 ? v : null;
}

/** Remaining seconds until ack deadline; null when not pending / no deadline. */
export function resolveDepartureAckCountdownSeconds(
  trip: Pick<AdminScheduledMonitoringTrip, 'scheduled_ack_status' | 'scheduled_ack_deadline_at'>,
  nowMs: number = Date.now(),
): number | null {
  if (norm(trip.scheduled_ack_status) !== 'pending') return null;
  const deadline = trip.scheduled_ack_deadline_at
    ? Date.parse(String(trip.scheduled_ack_deadline_at))
    : NaN;
  if (!Number.isFinite(deadline)) return null;
  return Math.max(0, Math.ceil((deadline - nowMs) / 1000));
}

export function formatCountdownLabel(seconds: number | null): string {
  if (seconds == null) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m <= 0) return `${s}s`;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

/**
 * Manual intervention required — true only for genuine ops exceptions.
 * Ordinary driver cancel / ack timeout with automatic rematch MUST NOT flag.
 */
export function resolveManualInterventionRequired(
  trip: AdminScheduledMonitoringTrip,
): boolean {
  const hold = norm(trip.scheduled_hold_reason);
  const scheduled = norm(trip.scheduled_status);
  const status = norm(trip.status);
  const ack = norm(trip.scheduled_ack_status);

  if (hold === 'publication_exhausted') return true;
  if (hold === 'payment_gate' || scheduled === 'payment_gate_blocked') return true;
  if (hold === 'airport_pricing') return true;
  if (hold === 'admin_exceptional' || hold === 'manual' || hold === 'manual_trip') return true;
  if (status === 'expired_no_driver' || scheduled === 'no_driver_found') return true;

  // Ack timeout while already rematching/searching = automatic recovery — not manual.
  if (ack === 'timed_out') {
    const recovering =
      scheduled === 'converted_to_instant' ||
      status === 'searching' ||
      status === 'searching_new_driver' ||
      status === 'broadcasting' ||
      status === 'offering';
    return !recovering;
  }

  // Alert pending is automated 45s window — monitor only.
  if (ack === 'pending') return false;

  return false;
}

export function resolveOperationalReadiness(
  trip: AdminScheduledMonitoringTrip,
): AdminScheduledReadiness {
  const hold = norm(trip.scheduled_hold_reason);
  const scheduled = norm(trip.scheduled_status);
  const payment = norm(trip.payment_state);

  let paymentOk = true;
  let paymentLabel = 'Payment ready';
  if (hold === 'payment_gate' || scheduled === 'payment_gate_blocked') {
    paymentOk = false;
    paymentLabel = 'Payment coverage blocked';
  } else if (payment.includes('authoris') || payment.includes('authorized') || payment === 'payment_authorized') {
    paymentLabel = 'Authorised hold';
  } else if (payment) {
    paymentLabel = `Payment: ${trip.payment_state}`;
  } else if (trip.payment_method) {
    paymentLabel = `Method on file (${trip.payment_method})`;
  }

  let airportOk = true;
  let airportLabel = 'Airport pricing OK';
  if (hold === 'airport_pricing') {
    airportOk = false;
    airportLabel = 'Airport pricing persistence failed';
  } else if (
    typeof trip.airport_charge_pence === 'number' &&
    trip.airport_charge_pence > 0
  ) {
    airportLabel = `Airport charge £${(trip.airport_charge_pence / 100).toFixed(2)}`;
  } else {
    airportLabel = 'No airport pricing hold';
  }

  return { paymentLabel, paymentOk, airportLabel, airportOk };
}

/** Compatible active/stacked journey — inferred when confirmed but ack not armed and activation deferred. */
export function resolveCompatibleJourneyLabel(
  trip: AdminScheduledMonitoringTrip,
): string | null {
  const confirmed = Boolean(nonEmpty(trip.confirmed_driver_id));
  const driverLive = Boolean(nonEmpty(trip.driver_id));
  const ack = norm(trip.scheduled_ack_status);
  const scheduled = norm(trip.scheduled_status);
  if (!confirmed || driverLive) return null;
  if (ack === 'pending' || ack === 'acknowledged') return null;
  if (
    scheduled === 'awaiting_activation_accept' ||
    scheduled === 'awaiting_confirmation' ||
    scheduled === 'driver_assigned'
  ) {
    // Backend defers arm while completing a compatible journey; no separate column.
    return 'May be deferred for compatible active/stacked journey until JIT window';
  }
  return null;
}

export function buildAdminScheduledWorkflowEvents(
  trip: AdminScheduledMonitoringTrip,
): AdminScheduledWorkflowEvent[] {
  const events: AdminScheduledWorkflowEvent[] = [];
  const push = (
    key: string,
    label: string,
    at: string | null | undefined,
    tone: AdminScheduledWorkflowEvent['tone'] = 'neutral',
  ) => {
    events.push({ key, label, at: at ? String(at) : null, tone });
  };

  if (trip.scheduled_broadcast_at) {
    const broadcastMs = Date.parse(String(trip.scheduled_broadcast_at));
    if (Number.isFinite(broadcastMs) && broadcastMs > Date.now()) {
      push(
        'awaiting_publication',
        'Awaiting automatic publication',
        trip.scheduled_broadcast_at,
        'warn',
      );
    } else {
      push(
        'published',
        'Requested — available in Scheduled Jobs',
        trip.scheduled_broadcast_at,
        'ok',
      );
    }
  } else if (
    norm(trip.scheduled_hold_reason) === 'publication_pending' ||
    norm(trip.scheduled_hold_reason) === 'publication_retry' ||
    norm(trip.scheduled_status) === 'admin_held'
  ) {
    push('awaiting_publication', 'Awaiting automatic publication', null, 'neutral');
  }
  if (trip.confirmed_driver_id) {
    push('accepted', 'Driver acceptance / pre-confirm', null, 'ok');
  }
  if (trip.scheduled_jit_activate_at) {
    push('jit', 'JIT departure deadline calculated', trip.scheduled_jit_activate_at, 'neutral');
  }
  if (resolveCompatibleJourneyLabel(trip)) {
    push('compatible', 'Compatible journey deferral possible', null, 'neutral');
  }
  if (trip.scheduled_ack_armed_at) {
    push('armed', 'Departure alert armed', trip.scheduled_ack_armed_at, 'warn');
  }
  if (trip.scheduled_ack_acknowledged_at) {
    push('acked', 'Departure acknowledged — heading path unlocked', trip.scheduled_ack_acknowledged_at, 'ok');
  }
  const ack = norm(trip.scheduled_ack_status);
  const reason = nonEmpty(trip.scheduled_ack_resolution_reason);
  if (ack === 'timed_out') {
    push('timeout', 'Acknowledgement timeout', trip.scheduled_ack_resolved_at, 'warn');
  }
  if (ack === 'cancelled' || reason?.includes('cancel')) {
    push('cancel', 'Driver cancellation / ack cancelled', trip.scheduled_ack_resolved_at, 'warn');
  }
  if (Array.isArray(trip.excluded_driver_ids) && trip.excluded_driver_ids.length > 0) {
    push(
      'excluded',
      `Driver exclusion (${trip.excluded_driver_ids.length})`,
      null,
      'warn',
    );
  }
  if (norm(trip.scheduled_status) === 'converted_to_instant') {
    push('instant', 'Converted to instant / rematch path', null, 'ok');
  }
  if (
    norm(trip.status) === 'searching' ||
    norm(trip.status) === 'searching_new_driver' ||
    norm(trip.scheduled_status) === 'broadcasting'
  ) {
    push('search', 'Replacement / dispatch search active', null, 'neutral');
  }
  if (norm(trip.scheduled_hold_reason) === 'publication_exhausted') {
    push('exhausted', 'Publication / dispatch exhaustion', null, 'bad');
  }
  if (trip.pending_release_kind && trip.pending_release_at) {
    push(
      'pending_release',
      `Pending ${trip.pending_release_kind} at`,
      trip.pending_release_at,
      'neutral',
    );
  }

  return events;
}

export type AdminScheduledOpsSnapshot = {
  targetArrivalLabel: string;
  jitDeadlineLabel: string;
  driverToPickupEtaLabel: string;
  ackDeadlineLabel: string;
  ackCountdownLabel: string;
  compatibleJourneyLabel: string | null;
  replacementSearchLabel: string | null;
  readiness: AdminScheduledReadiness;
  events: AdminScheduledWorkflowEvent[];
};

function formatAt(iso: string | null | undefined): string {
  if (!iso) return '—';
  const ms = Date.parse(String(iso));
  if (!Number.isFinite(ms)) return '—';
  try {
    return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
  } catch {
    return String(iso);
  }
}

/** Compact operational snapshot for Admin details — presentation only. */
export function buildAdminScheduledOpsSnapshot(
  trip: AdminScheduledMonitoringTrip,
  nowMs: number = Date.now(),
): AdminScheduledOpsSnapshot {
  const ackCountdown = resolveDepartureAckCountdownSeconds(trip, nowMs);
  const scheduled = norm(trip.scheduled_status);
  const status = norm(trip.status);
  let replacementSearchLabel: string | null = null;
  if (
    scheduled === 'converted_to_instant' ||
    status === 'searching' ||
    status === 'searching_new_driver' ||
    status === 'broadcasting' ||
    status === 'offering'
  ) {
    replacementSearchLabel =
      scheduled === 'converted_to_instant'
        ? 'Converted to instant — replacement search active'
        : 'Replacement / dispatch search active';
  } else if (status === 'expired_no_driver' || scheduled === 'no_driver_found') {
    replacementSearchLabel = 'Dispatch search exhausted';
  }

  const eta =
    typeof trip.scheduled_jit_eta_minutes === 'number' &&
    Number.isFinite(trip.scheduled_jit_eta_minutes)
      ? `${Math.round(trip.scheduled_jit_eta_minutes)} min`
      : '—';

  return {
    targetArrivalLabel: formatAt(trip.scheduled_at),
    jitDeadlineLabel: formatAt(trip.scheduled_jit_activate_at),
    driverToPickupEtaLabel: eta,
    ackDeadlineLabel: formatAt(trip.scheduled_ack_deadline_at),
    ackCountdownLabel: formatCountdownLabel(ackCountdown),
    compatibleJourneyLabel: resolveCompatibleJourneyLabel(trip),
    replacementSearchLabel,
    readiness: resolveOperationalReadiness(trip),
    events: buildAdminScheduledWorkflowEvents(trip),
  };
}
