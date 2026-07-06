/**
 * Card-trip capture confirmation — payments table + trips fields as SSOT.
 * Expected payable = final_customer_fare_pence + waiting + tip (mod already in final_customer).
 * Captured = payments.captured_amount_pence / trips.capture_amount_pence (Provider actual only).
 * Never label expected payable as "captured".
 */

import {
  getPaymentRowCapturedPence,
  getTripDriverNetPence as getTripDriverNetPenceSsot,
  getTripSettlementFarePence as getTripSettlementFarePenceSsot,
  isCardTrip,
} from '@/lib/tripSettlementFinanceSSOT';

export { isCardTrip, getPaymentRowCapturedPence } from '@/lib/tripSettlementFinanceSSOT';

export type CaptureStatusKind =
  | 'historical_legacy'
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
  has_shortfall_payment_intent?: boolean;
  payment_lifecycle_fees_pence?: number | null;
  payment_metadata_lifecycle_fees_pence?: number | null;
  arrival_cancellation_applied?: boolean | null;
  arrival_cancellation_fee?: number | null;
  fare_breakdown?: Record<string, unknown> | null;
  /** trip_finance.final_trip_total_pence — settlement SSOT when payments row absent */
  settlement_total_pence?: number | null;
  driver_net_pence?: number | null;
  /** Confirmed ledger TRIP_EARNING_NET for the trip */
  ledger_trip_earning_net_pence?: number | null;
  waiting_charge_pence?: number | null;
  pickup_waiting_charge_pence?: number | null;
  total_waiting_charge_pence?: number | null;
  /** Legacy trips.fare in pounds */
  fare?: number | null;
}

export interface TripSettlementBreakdown {
  baseFarePence: number;
  waitingPence: number;
  extrasPence: number;
  tipPence: number;
  totalSettlementPence: number;
  showBreakdown: boolean;
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

export interface PaymentCaptureRow {
  captured_amount_pence?: number | null;
  amount_pence?: number | null;
  status?: string | null;
  fee_type?: string | null;
  metadata?: Record<string, unknown> | null;
}

const MISMATCH_TOLERANCE_PENCE = 1;

const CAPTURE_PROBLEM_STATUSES = new Set([
  'capture_failed',
  'pending_capture',
  'pending',
  'capture_requested',
]);

const METADATA_LIFECYCLE_FEE_KEYS = [
  'arrival_cancellation_fee_pence',
  'cancellation_fee_pence',
  'late_cancel_fee_pence',
  'no_show_fee_pence',
  'waiting_surcharge_pence',
  'lifecycle_fee_pence',
] as const;

export function getTripTipPence(trip: TripCaptureFields): number {
  if (trip.tip_pence != null && trip.tip_pence > 0) return trip.tip_pence;
  if (trip.tip_amount_pence != null && trip.tip_amount_pence > 0) return trip.tip_amount_pence;
  if (trip.payment_tip_pence != null && trip.payment_tip_pence > 0) return trip.payment_tip_pence;
  const fb = trip.fare_breakdown as Record<string, number> | null;
  if (fb?.tip_pence != null && fb.tip_pence > 0) return fb.tip_pence;
  return 0;
}

/** Display ride fare in pence (excludes tip; may exclude waiting pass-through). */
export function getTripFarePence(trip: TripCaptureFields): number {
  if (trip.final_customer_fare_pence != null && trip.final_customer_fare_pence > 0) {
    return trip.final_customer_fare_pence;
  }
  if (trip.final_fare_pence != null && trip.final_fare_pence > 0) return trip.final_fare_pence;
  const captured = getCapturedTotalPence(trip);
  const tip = getTripTipPence(trip);
  if (captured != null && captured > tip) return captured - tip;
  return 0;
}

/** Settlement fare for capture reconciliation — uses final_fare_pence, not raw captured shortcut. */
function getReconciliationSettlementFarePence(trip: TripCaptureFields): number {
  if (trip.settlement_total_pence != null && trip.settlement_total_pence > 0) {
    return trip.settlement_total_pence;
  }
  if (trip.final_fare_pence != null) {
    return Math.max(0, trip.final_fare_pence);
  }
  return 0;
}

/**
 * Settlement / customer-paid fare for admin finance displays (Trip History, reconciliation views).
 * Admin extensions: settlement_total_pence, legacy trips.fare pounds.
 */
export function getTripSettlementFarePence(trip: TripCaptureFields): number {
  if (trip.settlement_total_pence != null && trip.settlement_total_pence > 0) {
    return trip.settlement_total_pence;
  }

  const captured = getCapturedTotalPence(trip);
  const ssotFare = getTripSettlementFarePenceSsot(trip, {
    paymentCapturedPence: captured,
  });
  if (ssotFare > 0) return ssotFare;

  if (trip.fare != null && trip.fare > 0) {
    return Math.round(trip.fare * 100);
  }

  return 0;
}

/** Driver net — ledger TRIP_EARNING_NET first, then trips.driver_net_pence. Never derived from display fare. */
export function getTripDriverNetPence(trip: TripCaptureFields): number | null {
  if (trip.ledger_trip_earning_net_pence != null && trip.ledger_trip_earning_net_pence >= 0) {
    return trip.ledger_trip_earning_net_pence;
  }
  return getTripDriverNetPenceSsot({ driver_net_pence: trip.driver_net_pence });
}

export function getTripSettlementBreakdown(trip: TripCaptureFields): TripSettlementBreakdown {
  const totalSettlementPence = getTripSettlementFarePence(trip);
  const tipPence = getTripTipPence(trip);
  const fb = trip.fare_breakdown as Record<string, number> | null;
  const waitingPence =
    trip.total_waiting_charge_pence ??
    trip.waiting_charge_pence ??
    trip.pickup_waiting_charge_pence ??
    (fb?.waiting_charge_pence ?? 0);

  // Prefer final_customer as ride base when waiting is present so breakdown can show waiting.
  const quotedBase =
    fb?.base_fare_pence ??
    fb?.quoted_fare_pence ??
    (waitingPence > 0 && trip.final_customer_fare_pence != null && trip.final_customer_fare_pence > 0
      ? trip.final_customer_fare_pence
      : null)
    ?? trip.final_fare_pence
    ?? trip.final_customer_fare_pence
    ?? 0;

  let baseFarePence = quotedBase > 0 ? quotedBase : Math.max(0, totalSettlementPence - waitingPence - tipPence);
  let extrasPence = Math.max(0, totalSettlementPence - baseFarePence - waitingPence - tipPence);

  if (extrasPence === 0 && trip.arrival_cancellation_applied && trip.arrival_cancellation_fee) {
    extrasPence = trip.arrival_cancellation_fee;
    baseFarePence = Math.max(0, totalSettlementPence - waitingPence - tipPence - extrasPence);
  }

  const showBreakdown =
    totalSettlementPence > baseFarePence &&
    (waitingPence > 0 || extrasPence > 0 || tipPence > 0);

  return {
    baseFarePence,
    waitingPence,
    extrasPence,
    tipPence,
    totalSettlementPence,
    showBreakdown,
  };
}

export function sumLifecycleFeesFromPaymentMetadata(
  metadataList: Array<Record<string, unknown> | null | undefined>,
): number {
  let sum = 0;
  for (const meta of metadataList) {
    if (!meta) continue;
    for (const key of METADATA_LIFECYCLE_FEE_KEYS) {
      const v = meta[key];
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) sum += v;
    }
  }
  return sum;
}

export function summarizeTripPayments(payments: PaymentCaptureRow[]): {
  capturedTotalPence: number | null;
  paymentCount: number;
  hasShortfallPaymentIntent: boolean;
  lifecycleFeesPence: number;
  metadataLifecycleFeesPence: number;
  tipFromMeta: number | null;
} {
  let capturedSum = 0;
  let lifecycleFees = 0;
  let hasShortfallPi = false;
  let tipFromMeta: number | null = null;
  const metadataList: Array<Record<string, unknown> | null> = [];

  for (const p of payments) {
    const rowCaptured = getPaymentRowCapturedPence(p);
    capturedSum += rowCaptured;

    const meta = p.metadata as Record<string, unknown> | null;
    metadataList.push(meta);

    if (!hasShortfallPi && typeof meta?.shortfall_pi_id === 'string' && meta.shortfall_pi_id.length > 0) {
      hasShortfallPi = true;
    }
    if (tipFromMeta == null) {
      const t = meta?.tip_pence != null ? Number(meta.tip_pence) : null;
      if (Number.isFinite(t) && t! > 0) tipFromMeta = t;
    }
    if (p.fee_type) {
      lifecycleFees += rowCaptured;
    }
    const postCaptureTip = meta?.post_capture_tip_pence != null
      ? Number(meta.post_capture_tip_pence)
      : 0;
    if (Number.isFinite(postCaptureTip) && postCaptureTip > 0) {
      capturedSum += postCaptureTip;
    }
  }

  return {
    capturedTotalPence: capturedSum > 0 ? capturedSum : null,
    paymentCount: payments.length,
    hasShortfallPaymentIntent: hasShortfallPi,
    lifecycleFeesPence: lifecycleFees,
    metadataLifecycleFeesPence: sumLifecycleFeesFromPaymentMetadata(metadataList),
    tipFromMeta,
  };
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

/** Lifecycle extras beyond settlement fare + tip (arrival cancellation, fee_type rows, metadata fees). */
export function getTripLifecycleExtrasPence(trip: TripCaptureFields): number {
  const fromPayments = trip.payment_lifecycle_fees_pence ?? 0;
  const fromMetadata = trip.payment_metadata_lifecycle_fees_pence ?? 0;
  const fromTrip =
    trip.arrival_cancellation_applied === true &&
    trip.arrival_cancellation_fee != null &&
    trip.arrival_cancellation_fee > 0
      ? trip.arrival_cancellation_fee
      : 0;

  if (fromPayments > 0) return fromPayments;
  if (fromMetadata > 0) return fromMetadata;
  return fromTrip;
}

export function getExpectedCustomerTotalPence(trip: TripCaptureFields): number | null {
  const tip = getTripTipPence(trip);
  const lifecycleExtras = getTripLifecycleExtrasPence(trip);
  const waiting = Math.max(
    0,
    trip.total_waiting_charge_pence
      ?? trip.waiting_charge_pence
      ?? trip.pickup_waiting_charge_pence
      ?? 0,
  );
  const finalCustomer =
    trip.final_customer_fare_pence != null && trip.final_customer_fare_pence > 0
      ? trip.final_customer_fare_pence
      : 0;
  const finalFare =
    trip.final_fare_pence != null && trip.final_fare_pence > 0
      ? trip.final_fare_pence
      : 0;

  if (finalCustomer > 0) {
    // final_customer already includes approved mods. Add waiting/tip only.
    const fromCustomer = finalCustomer + waiting + tip + lifecycleExtras;
    // final_fare is usable when it is not a mod double-count (MK-260704-002: 3007 = 1742+1241+24).
    if (finalFare > 0 && finalFare <= fromCustomer + 1) {
      return finalFare + tip + lifecycleExtras;
    }
    if (finalFare > fromCustomer + 50) {
      return fromCustomer;
    }
    return Math.max(fromCustomer, finalFare + tip + lifecycleExtras);
  }

  if (finalFare > 0) return finalFare + tip + lifecycleExtras;
  const fare = getReconciliationSettlementFarePence(trip);
  if (fare <= 0 && tip <= 0 && lifecycleExtras <= 0) return null;
  return fare + tip + lifecycleExtras;
}

/** Outstanding shortfall: expected payable − Provider captured (digital trips only). */
export function getOutstandingShortfallPence(trip: TripCaptureFields): number {
  if (!isCardTrip(trip)) return 0;
  const expected = getExpectedCustomerTotalPence(trip);
  const captured = getCapturedTotalPence(trip);
  if (expected == null || captured == null) return 0;
  return Math.max(0, expected - captured);
}

/** Count Provider payment intents (payments rows + shortfall PI stored in metadata). */
export function getTripPaymentIntentCount(
  paymentCount: number,
  hasShortfallPaymentIntent = false,
): number {
  return paymentCount + (hasShortfallPaymentIntent ? 1 : 0);
}

function paymentStatusIndicatesCaptureProblem(paymentStatus: string): boolean {
  return CAPTURE_PROBLEM_STATUSES.has(paymentStatus);
}

function shouldReportCaptureMismatch(
  capturedTotal: number,
  expectedTotal: number,
  paymentStatus: string,
): boolean {
  const diff = capturedTotal - expectedTotal;
  if (Math.abs(diff) <= MISMATCH_TOLERANCE_PENCE) return false;
  if (capturedTotal >= expectedTotal - MISMATCH_TOLERANCE_PENCE) return false;
  if (capturedTotal < expectedTotal - MISMATCH_TOLERANCE_PENCE) return true;
  return paymentStatusIndicatesCaptureProblem(paymentStatus);
}

function buildCapturedTooltip(
  split: boolean,
  paymentCount: number,
  capturedTotal: number,
  trip: TripCaptureFields,
): string {
  const fmt = (p: number) => (p / 100).toFixed(2);
  const fare = getTripSettlementFarePence(trip);
  const tip = getTripTipPence(trip);
  const extras = getTripLifecycleExtrasPence(trip);

  if (split) {
    const parts = [`${paymentCount} payment intents`];
    if (trip.has_shortfall_payment_intent) {
      parts.push('includes shortfall PI from auth cap');
    }
    parts.push(`${fmt(capturedTotal)} captured matches settlement total`);
    parts.push(`fare ${fmt(fare)} + tip ${fmt(tip)}${extras > 0 ? ` + fees ${fmt(extras)}` : ''}`);
    return parts.join('; ');
  }

  return `Captured ${fmt(capturedTotal)} matches customer total (fare ${fmt(fare)} + tip ${fmt(tip)}${extras > 0 ? ` + fees ${fmt(extras)}` : ''})`;
}

function baseStatus(
  trip: TripCaptureFields,
  overrides: Partial<TripCaptureStatus> & Pick<TripCaptureStatus, 'kind' | 'label' | 'shortLabel'>,
): TripCaptureStatus {
  const farePence = getTripFarePence(trip);
  const tipPence = getTripTipPence(trip);
  const capturedTotalPence = getCapturedTotalPence(trip);
  const expectedTotalPence = getExpectedCustomerTotalPence(trip);
  const paymentCount =
    getTripPaymentIntentCount(
      trip.payment_count ?? (capturedTotalPence != null && capturedTotalPence > 0 ? 1 : 0),
      trip.has_shortfall_payment_intent === true,
    );
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
        kind: 'historical_legacy',
        label: 'Historical Legacy Trip',
        shortLabel: 'Historical Legacy Trip',
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
  const paymentCount = getTripPaymentIntentCount(
    trip.payment_count ?? (capturedTotal != null && capturedTotal > 0 ? 1 : 0),
    trip.has_shortfall_payment_intent === true,
  );

  if (capturedTotal == null || capturedTotal <= 0) {
    if (paymentStatus === 'pending_capture' || paymentStatus === 'pending') {
      return baseStatus(trip, {
        kind: 'pending_capture',
        label: 'Pending capture',
        shortLabel: 'Pending capture',
        tooltip: 'Card authorised but not yet captured in Provider.',
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
        : `${(capturedTotal / 100).toFixed(2)} captured in Provider`,
    });
  }

  const split = paymentCount > 1;
  const capturedOk = capturedTotal >= expectedTotal - MISMATCH_TOLERANCE_PENCE;

  if (capturedOk) {
    return baseStatus(trip, {
      kind: split ? 'captured_split' : 'captured',
      label: split ? 'Captured (split) ✓' : 'Captured ✓',
      shortLabel: split ? 'Captured (split) ✓' : 'Captured ✓',
      tooltip: buildCapturedTooltip(split, paymentCount, capturedTotal, trip),
    });
  }

  if (!shouldReportCaptureMismatch(capturedTotal, expectedTotal, paymentStatus)) {
    return baseStatus(trip, {
      kind: split ? 'captured_split' : 'captured',
      label: split ? 'Captured (split) ✓' : 'Captured ✓',
      shortLabel: split ? 'Captured (split) ✓' : 'Captured ✓',
      tooltip: buildCapturedTooltip(split, paymentCount, capturedTotal, trip),
    });
  }

  const fmt = (p: number) => (p / 100).toFixed(2);
  const fare = getTripSettlementFarePence(trip);
  const tip = getTripTipPence(trip);
  const extras = getTripLifecycleExtrasPence(trip);
  const diff = capturedTotal - expectedTotal;
  const extrasLabel = extras > 0 ? ` + fees ${fmt(extras)}` : '';

  return baseStatus(trip, {
    kind: 'capture_mismatch',
    label: 'Capture mismatch',
    shortLabel: 'Capture mismatch',
    tooltip: `Expected ${fmt(expectedTotal)} (fare ${fmt(fare)} + tip ${fmt(tip)}${extrasLabel}); captured ${fmt(capturedTotal)} (${diff > 0 ? '+' : ''}${fmt(diff)}). Provider did not capture the full customer total.`,
  });
}

export function captureStatusColorClass(kind: CaptureStatusKind): string {
  switch (kind) {
    case 'captured':
    case 'captured_split':
    case 'historical_legacy':
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
