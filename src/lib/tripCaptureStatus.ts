/**
 * Card-trip capture confirmation — payments table + trips fields as SSOT.
 * Expected customer total = ride fare + tip; captured = sum of payment intents.
 */

export type CaptureStatusKind =
  | 'cash_collected'
  | 'pending_capture'
  | 'pending'
  | 'captured'
  | 'captured_split'
  | 'capture_mismatch'
  | 'refunded'
  | 'unknown';

export interface TripCaptureFields {
  payment_method?: string | null;
  payment_status?: string | null;
  final_fare_pence?: number | null;
  final_customer_fare_pence?: number | null;
  gross_fare_pence?: number | null;
  capture_amount_pence?: number | null;
  tip_pence?: number | null;
  tip_amount_pence?: number | null;
  payment_captured_pence?: number | null;
  payment_tip_pence?: number | null;
  payment_count?: number;
  fare_breakdown?: Record<string, unknown> | null;
}

export interface TripCaptureStatus {
  kind: CaptureStatusKind;
  label: string;
  shortLabel: string;
  tooltip?: string;
  expectedTotalPence: number | null;
  capturedTotalPence: number | null;
  farePence: number;
  tipPence: number;
  paymentCount: number;
  diffPence: number | null;
}

const CARD_METHODS = new Set(['card', 'apple_pay', 'google_pay']);
const MISMATCH_TOLERANCE_PENCE = 1;

export function isCardTrip(trip: { payment_method?: string | null }): boolean {
  const m = (trip.payment_method || '').toLowerCase();
  return CARD_METHODS.has(m);
}

export function getTripTipPence(trip: TripCaptureFields): number {
  if (trip.tip_pence != null && trip.tip_pence > 0) return trip.tip_pence;
  if (trip.tip_amount_pence != null && trip.tip_amount_pence > 0) return trip.tip_amount_pence;
  if (trip.payment_tip_pence != null && trip.payment_tip_pence > 0) return trip.payment_tip_pence;
  const fb = trip.fare_breakdown as Record<string, number> | null;
  if (fb?.tip_pence != null && fb.tip_pence > 0) return fb.tip_pence;
  return 0;
}

/** Ride fare in pence (excludes tip). */
export function getTripFarePence(trip: TripCaptureFields): number {
  if (trip.final_customer_fare_pence != null && trip.final_customer_fare_pence > 0) {
    return trip.final_customer_fare_pence;
  }
  if (trip.final_fare_pence != null && trip.final_fare_pence > 0) return trip.final_fare_pence;
  if (trip.gross_fare_pence != null && trip.gross_fare_pence > 0) return trip.gross_fare_pence;
  const captured = getCapturedTotalPence(trip);
  const tip = getTripTipPence(trip);
  if (captured != null && captured > tip) return captured - tip;
  return 0;
}

/** Sum of payments.captured_amount_pence, falling back to trips.capture_amount_pence. */
export function getCapturedTotalPence(trip: TripCaptureFields): number | null {
  if (trip.payment_captured_pence != null && trip.payment_captured_pence > 0) {
    return trip.payment_captured_pence;
  }
  if (trip.capture_amount_pence != null && trip.capture_amount_pence > 0) {
    return trip.capture_amount_pence;
  }
  return null;
}

export function getExpectedCustomerTotalPence(trip: TripCaptureFields): number | null {
  const fare = getTripFarePence(trip);
  const tip = getTripTipPence(trip);
  if (fare <= 0 && tip <= 0) return null;
  return fare + tip;
}

function baseStatus(
  trip: TripCaptureFields,
  overrides: Partial<TripCaptureStatus> & Pick<TripCaptureStatus, 'kind' | 'label' | 'shortLabel'>,
): TripCaptureStatus {
  const farePence = getTripFarePence(trip);
  const tipPence = getTripTipPence(trip);
  const capturedTotalPence = getCapturedTotalPence(trip);
  const expectedTotalPence = getExpectedCustomerTotalPence(trip);
  const paymentCount = trip.payment_count ?? (capturedTotalPence != null && capturedTotalPence > 0 ? 1 : 0);
  const diffPence =
    expectedTotalPence != null && capturedTotalPence != null
      ? capturedTotalPence - expectedTotalPence
      : null;

  return {
    expectedTotalPence,
    capturedTotalPence,
    farePence,
    tipPence,
    paymentCount,
    diffPence,
    tooltip: undefined,
    ...overrides,
  };
}

export function getTripCaptureStatus(trip: TripCaptureFields): TripCaptureStatus {
  const paymentStatus = (trip.payment_status || '').toLowerCase();

  if (!isCardTrip(trip)) {
    if (paymentStatus === 'collected_cash') {
      return baseStatus(trip, {
        kind: 'cash_collected',
        label: 'Cash collected',
        shortLabel: '✓ Cash collected',
      });
    }
    return baseStatus(trip, {
      kind: 'unknown',
      label: trip.payment_status || '—',
      shortLabel: trip.payment_status || '—',
    });
  }

  if (paymentStatus === 'refunded' || paymentStatus === 'partially_refunded') {
    return baseStatus(trip, {
      kind: 'refunded',
      label: paymentStatus === 'partially_refunded' ? 'Partially refunded' : 'Refunded',
      shortLabel: paymentStatus === 'partially_refunded' ? 'Partial refund' : 'Refunded',
    });
  }

  const capturedTotal = getCapturedTotalPence(trip);
  const expectedTotal = getExpectedCustomerTotalPence(trip);
  const paymentCount = trip.payment_count ?? (capturedTotal != null && capturedTotal > 0 ? 1 : 0);

  if (capturedTotal == null || capturedTotal <= 0) {
    if (paymentStatus === 'pending_capture' || paymentStatus === 'pending') {
      return baseStatus(trip, {
        kind: 'pending_capture',
        label: 'Pending capture',
        shortLabel: 'Pending capture',
        tooltip: 'Card authorised but not yet captured in Stripe.',
      });
    }
    return baseStatus(trip, {
      kind: 'pending',
      label: trip.payment_status || 'No capture',
      shortLabel: trip.payment_status || '—',
    });
  }

  if (expectedTotal == null) {
    const split = paymentCount > 1;
    return baseStatus(trip, {
      kind: split ? 'captured_split' : 'captured',
      label: split ? 'Captured (split) ✓' : 'Captured ✓',
      shortLabel: split ? 'Captured (split) ✓' : 'Captured ✓',
      tooltip: split
        ? `${paymentCount} payment intents; ${(capturedTotal / 100).toFixed(2)} captured total`
        : `${(capturedTotal / 100).toFixed(2)} captured in Stripe`,
    });
  }

  const diff = capturedTotal - expectedTotal;
  if (Math.abs(diff) <= MISMATCH_TOLERANCE_PENCE) {
    const split = paymentCount > 1;
    const fmt = (p: number) => (p / 100).toFixed(2);
    return baseStatus(trip, {
      kind: split ? 'captured_split' : 'captured',
      label: split ? 'Captured (split) ✓' : 'Captured ✓',
      shortLabel: split ? 'Captured (split) ✓' : 'Captured ✓',
      tooltip: split
        ? `${paymentCount} payment intents; ${fmt(capturedTotal)} captured matches fare ${fmt(getTripFarePence(trip))} + tip ${fmt(getTripTipPence(trip))}`
        : `Captured ${fmt(capturedTotal)} matches customer total (fare + tip)`,
    });
  }

  const fmt = (p: number) => (p / 100).toFixed(2);
  const fare = getTripFarePence(trip);
  const tip = getTripTipPence(trip);
  return baseStatus(trip, {
    kind: 'capture_mismatch',
    label: 'Capture mismatch',
    shortLabel: 'Capture mismatch',
    tooltip: `Expected ${fmt(expectedTotal)} (fare ${fmt(fare)} + tip ${fmt(tip)}); captured ${fmt(capturedTotal)} (${diff > 0 ? '+' : ''}${fmt(diff)})`,
  });
}

export function captureStatusColorClass(kind: CaptureStatusKind): string {
  switch (kind) {
    case 'captured':
    case 'captured_split':
    case 'cash_collected':
      return 'text-green-600';
    case 'capture_mismatch':
      return 'text-amber-600';
    case 'pending_capture':
    case 'pending':
      return 'text-amber-600';
    case 'refunded':
      return 'text-muted-foreground';
    default:
      return 'text-muted-foreground';
  }
}
