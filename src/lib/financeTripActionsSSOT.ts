/** Operational trip/payment action availability — never gated on reconciliation mismatch. */

export type PaymentActionKey =
  | 'capture'
  | 'refund_full'
  | 'refund_partial'
  | 'cancel_authorisation'
  | 'void_payment'
  | 'retry_capture'
  | 'retry_settlement'
  | 'repair_settlement'
  | 'recalculate_settlement'
  | 'resync_stripe'
  | 'refresh_stripe'
  | 'request_extra_payment';

export type PaymentActionAvailability = Record<PaymentActionKey, { enabled: boolean; reason?: string }>;

export type TripPaymentActionInput = {
  paymentMethod?: string | null;
  stripeStatus?: string | null;
  paymentStatus?: string | null;
  capturedPence?: number;
  refundedPence?: number;
  refundablePence?: number;
  authorizedPence?: number;
  amountCapturablePence?: number | null;
  outstandingPence?: number;
  hasPaymentIntent?: boolean;
  hasCharge?: boolean;
  tripCancelled?: boolean;
  stripeSettlementVerified?: boolean;
  actionsAllowed?: {
    can_capture?: boolean;
    can_refund?: boolean;
    can_partial_refund?: boolean;
    can_cancel_authorisation?: boolean;
    can_sync_stripe?: boolean;
  };
};

function disabled(reason: string): { enabled: false; reason: string } {
  return { enabled: false, reason };
}

function enabled(): { enabled: true } {
  return { enabled: true };
}

export function isDigitalTripPayment(method: string | null | undefined): boolean {
  const m = String(method ?? '').toLowerCase();
  return m !== '' && m !== 'cash' && m !== 'cash_only';
}

export function derivePaymentActionAvailability(input: TripPaymentActionInput): PaymentActionAvailability {
  const digital = isDigitalTripPayment(input.paymentMethod);
  const stripeStatus = String(input.stripeStatus ?? '').toLowerCase();
  const paymentStatus = String(input.paymentStatus ?? '').toLowerCase();
  const captured = Math.max(0, input.capturedPence ?? 0);
  const refunded = Math.max(0, input.refundedPence ?? 0);
  const refundable = Math.max(0, input.refundablePence ?? captured - refunded);
  const capturable = Math.max(0, input.amountCapturablePence ?? 0);
  const outstanding = Math.max(0, input.outstandingPence ?? 0);
  const tripCancelled = input.tripCancelled === true
    || paymentStatus.includes('cancel')
    || stripeStatus === 'canceled';
  const fullyRefunded = captured > 0 && refundable <= 0;
  const isUncaptured = stripeStatus === 'requires_capture' && capturable > 0;
  const hasPi = input.hasPaymentIntent === true;
  const hasCharge = input.hasCharge === true || captured > 0;
  const canCapture = input.actionsAllowed?.can_capture ?? (digital && isUncaptured && !tripCancelled && !fullyRefunded);
  const canRefund = input.actionsAllowed?.can_refund ?? (digital && captured > 0 && refundable > 0 && !tripCancelled);
  const canPartialRefund = input.actionsAllowed?.can_partial_refund ?? canRefund;
  const canCancelAuth = input.actionsAllowed?.can_cancel_authorisation ?? (digital && isUncaptured && !tripCancelled);
  const canSync = input.actionsAllowed?.can_sync_stripe ?? (digital && hasPi);

  return {
    capture: canCapture ? enabled() : disabled(
      !digital ? 'Historical legacy trip — no operational finance actions'
        : !hasPi ? 'No PaymentIntent'
          : !isUncaptured ? 'Payment is not awaiting capture'
            : tripCancelled ? 'Trip cancelled'
              : 'Capture not available for current Stripe state',
    ),
    retry_capture: canCapture ? enabled() : disabled('Retry capture requires an uncaptured authorisation'),
    void_payment: isUncaptured ? enabled() : disabled('Void applies only before capture (authorised hold)'),
    cancel_authorisation: canCancelAuth ? enabled() : disabled('No active authorisation to cancel'),
    refund_full: canRefund ? enabled() : disabled(
      fullyRefunded ? 'Already fully refunded'
        : captured <= 0 ? 'Nothing captured to refund'
          : 'Full refund not available',
    ),
    refund_partial: canPartialRefund ? enabled() : disabled(
      fullyRefunded ? 'Already fully refunded'
        : captured <= 0 ? 'Nothing captured to refund'
          : 'Partial refund not available',
    ),
    resync_stripe: canSync ? enabled() : disabled('No Stripe PaymentIntent to sync'),
    refresh_stripe: canSync ? enabled() : disabled('No Stripe PaymentIntent to refresh'),
    repair_settlement: digital && hasCharge
      ? enabled()
      : disabled('Settlement repair requires a captured digital payment'),
    recalculate_settlement: digital && captured > 0
      ? enabled()
      : disabled('Recalculate settlement requires captured payment'),
    retry_settlement: digital && hasCharge && input.stripeSettlementVerified === false
      ? enabled()
      : disabled(
        input.stripeSettlementVerified ? 'Settlement already verified'
          : 'Retry settlement requires captured payment',
      ),
    request_extra_payment: outstanding > 0 && digital
      ? enabled()
      : disabled(outstanding <= 0 ? 'No outstanding balance' : 'Extra payment is for digital trips only'),
  };
}
