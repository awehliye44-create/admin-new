import Stripe from "https://esm.sh/stripe@14.21.0";

type SupabaseLike = {
  from: (table: string) => any;
};

export interface StripeSettlementResult {
  capturedPaymentIntent: Stripe.PaymentIntent;
  chargeId: string | null;
  capturedAmountPence: number;
  stripeFeePence: number;
  applicationFeeId: string | null;
  applicationFeeAmountPence: number | null;
  destinationAccountId: string | null;
  transferId: string | null;
  transferAmountPence: number | null;
  settlementMode: 'destination_charge' | 'separate_charge_transfer' | 'platform_charge_only';
  settlementVerified: boolean;
  settlementWarning: string | null;
}

const asStripeId = (value: unknown): string | null => {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && 'id' in value && typeof (value as { id?: unknown }).id === 'string') {
    return (value as { id: string }).id;
  }
  return null;
};

const asStripeAmount = (value: unknown): number | null => {
  if (!value || typeof value !== 'object' || !('amount' in value)) return null;
  const amount = (value as { amount?: unknown }).amount;
  return typeof amount === 'number' ? amount : null;
};

export async function capturePaymentIntentWithSettlement({
  stripe,
  supabase,
  tripId,
  driverId,
  paymentIntentId,
  captureAmountPence,
  commissionPence,
  driverPayoutPence,
  currencyCode,
  driverStripeAccountId,
  idempotencyKey,
}: {
  stripe: Stripe;
  supabase?: SupabaseLike;
  tripId: string;
  driverId?: string | null;
  paymentIntentId: string;
  captureAmountPence: number;
  commissionPence: number;
  driverPayoutPence: number;
  currencyCode: string;
  driverStripeAccountId?: string | null;
  idempotencyKey: string;
}): Promise<StripeSettlementResult> {
  const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
  if (paymentIntent.status !== 'requires_capture') {
    throw new Error(`Cannot capture — PaymentIntent status is "${paymentIntent.status}"`);
  }

  let destinationAccountId = asStripeId(paymentIntent.transfer_data?.destination);
  let resolvedDriverAccountId = driverStripeAccountId ?? null;

  if (!resolvedDriverAccountId && driverId && supabase) {
    const { data: driver } = await supabase
      .from('drivers')
      .select('stripe_account_id')
      .eq('id', driverId)
      .maybeSingle();
    resolvedDriverAccountId = driver?.stripe_account_id ?? null;
  }

  const captureParams: Stripe.PaymentIntentCaptureParams = {
    amount_to_capture: captureAmountPence,
  };

  if (destinationAccountId && commissionPence > 0) {
    captureParams.application_fee_amount = commissionPence;
  }

  console.log(
    `[stripe-settlement] trip=${tripId} pi=${paymentIntentId} capture=${captureAmountPence}p commission=${commissionPence}p ` +
    `application_fee_amount=${captureParams.application_fee_amount ?? 'none'} destination=${destinationAccountId ?? 'none'} ` +
    `driver_account=${resolvedDriverAccountId ?? 'none'}`,
  );

  const capturedPaymentIntent = await stripe.paymentIntents.capture(paymentIntentId, captureParams, { idempotencyKey });
  const latestChargeId = asStripeId(capturedPaymentIntent.latest_charge);

  let chargeId: string | null = latestChargeId;
  let capturedAmountPence = captureAmountPence;
  let stripeFeePence = 0;
  let applicationFeeId: string | null = null;
  let applicationFeeAmountPence: number | null = null;
  let transferId: string | null = null;
  let transferAmountPence: number | null = null;
  let settlementMode: StripeSettlementResult['settlementMode'] = destinationAccountId
    ? 'destination_charge'
    : resolvedDriverAccountId
      ? 'separate_charge_transfer'
      : 'platform_charge_only';

  if (chargeId) {
    const charge = await stripe.charges.retrieve(chargeId, {
      expand: ['balance_transaction', 'application_fee', 'transfer'],
    });

    chargeId = charge.id;
    capturedAmountPence = charge.amount_captured ?? captureAmountPence;
    const balanceTransaction = charge.balance_transaction;
    if (balanceTransaction && typeof balanceTransaction === 'object' && 'fee' in balanceTransaction) {
      stripeFeePence = (balanceTransaction as Stripe.BalanceTransaction).fee ?? 0;
    }

    applicationFeeId = asStripeId(charge.application_fee);
    applicationFeeAmountPence = asStripeAmount(charge.application_fee);
    transferId = asStripeId((charge as unknown as { transfer?: unknown }).transfer);
    transferAmountPence = asStripeAmount((charge as unknown as { transfer?: unknown }).transfer);
  }

  if (!destinationAccountId && resolvedDriverAccountId && chargeId && driverPayoutPence > 0) {
    const transfer = await stripe.transfers.create(
      {
        amount: driverPayoutPence,
        currency: currencyCode.toLowerCase(),
        destination: resolvedDriverAccountId,
        source_transaction: chargeId,
        metadata: {
          trip_id: tripId,
          payment_intent_id: paymentIntentId,
          settlement_mode: 'separate_charge_transfer',
          commission_pence: String(commissionPence),
        },
      },
      { idempotencyKey: `${idempotencyKey}_driver_transfer` },
    );

    destinationAccountId = resolvedDriverAccountId;
    transferId = transfer.id;
    transferAmountPence = transfer.amount;
    settlementMode = 'separate_charge_transfer';
    console.warn(`[stripe-settlement] PI ${paymentIntentId} had no destination; created separate transfer ${transfer.id} for ${transfer.amount}p`);
  }

  if (applicationFeeId && applicationFeeAmountPence === null) {
    try {
      const applicationFee = await stripe.applicationFees.retrieve(applicationFeeId);
      applicationFeeAmountPence = applicationFee.amount ?? null;
    } catch (error) {
      console.warn(`[stripe-settlement] Could not retrieve application fee ${applicationFeeId}: ${(error as Error).message}`);
    }
  }

  let settlementVerified = false;
  let settlementWarning: string | null = null;

  if (settlementMode === 'destination_charge') {
    settlementVerified = applicationFeeAmountPence === commissionPence && !!applicationFeeId && !!destinationAccountId;
    if (!settlementVerified) {
      settlementWarning = `DESTINATION_CHARGE_APP_FEE_MISMATCH expected=${commissionPence} actual=${applicationFeeAmountPence ?? 'none'} fee_id=${applicationFeeId ?? 'none'}`;
    }
  } else if (settlementMode === 'separate_charge_transfer') {
    settlementVerified = transferAmountPence === driverPayoutPence && !!transferId && !!destinationAccountId;
    settlementWarning = settlementVerified
      ? 'SEPARATE_CHARGE_TRANSFER_USED_NO_APPLICATION_FEE_OBJECT'
      : `SEPARATE_TRANSFER_MISMATCH expected=${driverPayoutPence} actual=${transferAmountPence ?? 'none'}`;
  } else {
    settlementVerified = true;
    settlementWarning = 'NO_DRIVER_CONNECT_ACCOUNT_PLATFORM_RETAINED_FULL_CHARGE_MANUAL_PAYOUT_REQUIRED';
  }

  console.log(
    `[stripe-settlement] verified=${settlementVerified} mode=${settlementMode} charge=${chargeId ?? 'none'} ` +
    `application_fee_id=${applicationFeeId ?? 'none'} application_fee_amount=${applicationFeeAmountPence ?? 'none'} ` +
    `transfer=${transferId ?? 'none'} transfer_amount=${transferAmountPence ?? 'none'} stripe_fee=${stripeFeePence}p ` +
    `warning=${settlementWarning ?? 'none'}`,
  );

  return {
    capturedPaymentIntent,
    chargeId,
    capturedAmountPence,
    stripeFeePence,
    applicationFeeId,
    applicationFeeAmountPence,
    destinationAccountId,
    transferId,
    transferAmountPence,
    settlementMode,
    settlementVerified,
    settlementWarning,
  };
}