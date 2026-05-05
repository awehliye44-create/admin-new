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
  effectiveDriverTransferAmountPence: number | null;
  platformNetAmountPence: number | null;
  transferReversalId: string | null;
  applicationFeeBalanceTransactionId: string | null;
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
  let paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
  if (paymentIntent.status !== 'requires_capture') {
    throw new Error(`Cannot capture — PaymentIntent status is "${paymentIntent.status}"`);
  }

  if (commissionPence < 0 || commissionPence > captureAmountPence) {
    throw new Error(`Invalid commission for Stripe settlement: commission=${commissionPence} capture=${captureAmountPence}`);
  }

  const expectedDriverTransferAmountPence = Math.max(0, captureAmountPence - commissionPence);
  if (driverPayoutPence !== expectedDriverTransferAmountPence) {
    console.warn(
      `[stripe-settlement] driver payout override ignored for trip=${tripId}; ` +
      `requested=${driverPayoutPence}p expected_final_fare_minus_commission=${expectedDriverTransferAmountPence}p`,
    );
  }
  const driverTransferAmountPence = expectedDriverTransferAmountPence;

  let platformAccountId: string | null = null;
  try {
    const platformAccount = await stripe.accounts.retrieve();
    platformAccountId = platformAccount.id;
  } catch (error) {
    console.warn(`[stripe-settlement] Could not resolve platform Stripe account: ${(error as Error).message}`);
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

  if (destinationAccountId && resolvedDriverAccountId && destinationAccountId !== resolvedDriverAccountId) {
    throw new Error(`STRIPE_DESTINATION_MISMATCH: PaymentIntent destination ${destinationAccountId} does not match driver account ${resolvedDriverAccountId}`);
  }

  if (!destinationAccountId && resolvedDriverAccountId) {
    try {
      paymentIntent = await stripe.paymentIntents.update(
        paymentIntentId,
        {
          transfer_data: { destination: resolvedDriverAccountId },
          ...(commissionPence > 0 ? { application_fee_amount: commissionPence } : {}),
          metadata: {
            ...paymentIntent.metadata,
            trip_id: tripId,
            connect_flow: 'destination_charge',
            settlement_normalized_before_capture: 'true',
            commission_pence: String(commissionPence),
            expected_driver_transfer_amount_pence: String(driverTransferAmountPence),
          },
        },
        { idempotencyKey: `${idempotencyKey}_connect_destination_normalize` },
      );
      destinationAccountId = asStripeId(paymentIntent.transfer_data?.destination);
      console.log(`[stripe-settlement] Normalized PI ${paymentIntentId} to destination charge destination=${destinationAccountId ?? 'none'} application_fee_amount=${commissionPence}`);
    } catch (error) {
      console.error(`[stripe-settlement] Could not normalize PI ${paymentIntentId} to destination charge; falling back to separate charge + transfer: ${(error as Error).message}`);
    }
  }

  const captureParams: Stripe.PaymentIntentCaptureParams = {
    amount_to_capture: captureAmountPence,
    metadata: {
      trip_id: tripId,
      final_fare_pence: String(captureAmountPence),
      commission_pence: String(commissionPence),
      driver_transfer_amount: String(driverTransferAmountPence),
      connected_account_id: destinationAccountId ?? resolvedDriverAccountId ?? 'none',
      platform_account_id: platformAccountId ?? 'unknown',
      settlement_mode: destinationAccountId ? 'destination_charge' : resolvedDriverAccountId ? 'separate_charge_transfer' : 'platform_charge_only',
    },
  };

  if (destinationAccountId && commissionPence > 0) {
    captureParams.application_fee_amount = commissionPence;
  }

  console.log(
    `[stripe-settlement] trip=${tripId} pi=${paymentIntentId} final_fare_pence=${captureAmountPence} commission_pence=${commissionPence} ` +
    `driver_transfer_amount=${driverTransferAmountPence} application_fee_amount=${captureParams.application_fee_amount ?? 'none'} ` +
    `destination=${destinationAccountId ?? 'none'} driver_account=${resolvedDriverAccountId ?? 'none'} platform_account=${platformAccountId ?? 'unknown'}`,
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
  let effectiveDriverTransferAmountPence: number | null = null;
  let transferReversalId: string | null = null;
  let applicationFeeBalanceTransactionId: string | null = null;
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

  if (applicationFeeId) {
    try {
      const applicationFee = await stripe.applicationFees.retrieve(applicationFeeId, { expand: ['balance_transaction'] });
      applicationFeeAmountPence = applicationFee.amount ?? applicationFeeAmountPence;
      applicationFeeBalanceTransactionId = asStripeId(applicationFee.balance_transaction);
    } catch (error) {
      console.warn(`[stripe-settlement] Could not retrieve application fee ${applicationFeeId}: ${(error as Error).message}`);
    }
  }

  if (!destinationAccountId && resolvedDriverAccountId && chargeId && driverTransferAmountPence > 0) {
    const transfer = await stripe.transfers.create(
      {
        amount: driverTransferAmountPence,
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
    effectiveDriverTransferAmountPence = transfer.amount;
    settlementMode = 'separate_charge_transfer';
    console.warn(`[stripe-settlement] PI ${paymentIntentId} had no destination; created separate transfer ${transfer.id} for ${transfer.amount}p`);
  }

  if (settlementMode === 'destination_charge') {
    effectiveDriverTransferAmountPence = Math.max(0, capturedAmountPence - (applicationFeeAmountPence ?? 0));

    const missingCommissionPence = Math.max(0, commissionPence - (applicationFeeAmountPence ?? 0));
    if (missingCommissionPence > 0 && transferId) {
      const reversal = await stripe.transfers.createReversal(
        transferId,
        {
          amount: missingCommissionPence,
          metadata: {
            trip_id: tripId,
            payment_intent_id: paymentIntentId,
            reason: 'missing_or_partial_application_fee_commission_recovery',
            expected_commission_pence: String(commissionPence),
            existing_application_fee_pence: String(applicationFeeAmountPence ?? 0),
          },
        },
        { idempotencyKey: `${idempotencyKey}_commission_reversal` },
      );
      transferReversalId = reversal.id;
      effectiveDriverTransferAmountPence = Math.max(0, effectiveDriverTransferAmountPence - reversal.amount);
      console.error(
        `[stripe-settlement] application_fee missing/mismatched; reversed ${reversal.amount}p from transfer=${transferId} ` +
        `reversal=${reversal.id} to retain ONECAB commission`,
      );
    }
  }

  const platformGrossRetainedPence = settlementMode === 'destination_charge'
    ? ((applicationFeeAmountPence ?? 0) + (transferReversalId ? Math.max(0, commissionPence - (applicationFeeAmountPence ?? 0)) : 0))
    : Math.max(0, capturedAmountPence - (transferAmountPence ?? 0));
  const platformNetAmountPence = Math.max(0, platformGrossRetainedPence - stripeFeePence);

  let settlementVerified = false;
  let settlementWarning: string | null = null;

  if (settlementMode === 'destination_charge') {
    settlementVerified = applicationFeeAmountPence === commissionPence && !!applicationFeeId && !!destinationAccountId && effectiveDriverTransferAmountPence === driverTransferAmountPence;
    if (!settlementVerified) {
      settlementWarning = transferReversalId
        ? `DESTINATION_CHARGE_APP_FEE_MISMATCH_RECOVERED_BY_TRANSFER_REVERSAL expected=${commissionPence} actual=${applicationFeeAmountPence ?? 'none'} reversal=${transferReversalId}`
        : `DESTINATION_CHARGE_APP_FEE_MISMATCH expected=${commissionPence} actual=${applicationFeeAmountPence ?? 'none'} fee_id=${applicationFeeId ?? 'none'}`;
    }
  } else if (settlementMode === 'separate_charge_transfer') {
    settlementVerified = transferAmountPence === driverTransferAmountPence && !!transferId && !!destinationAccountId;
    settlementWarning = settlementVerified
      ? 'SEPARATE_CHARGE_TRANSFER_USED_NO_APPLICATION_FEE_OBJECT'
      : `SEPARATE_TRANSFER_MISMATCH expected=${driverTransferAmountPence} actual=${transferAmountPence ?? 'none'}`;
  } else {
    settlementVerified = true;
    settlementWarning = 'NO_DRIVER_CONNECT_ACCOUNT_PLATFORM_RETAINED_FULL_CHARGE_MANUAL_PAYOUT_REQUIRED';
  }

  console.log(
    `[stripe-settlement-reconciliation] verified=${settlementVerified} mode=${settlementMode} ` +
    `final_fare_pence=${capturedAmountPence} commission_pence=${commissionPence} stripe_fee_pence=${stripeFeePence} ` +
    `driver_transfer_amount=${driverTransferAmountPence} effective_driver_transfer_amount=${effectiveDriverTransferAmountPence ?? 'none'} ` +
    `application_fee_amount=${applicationFeeAmountPence ?? 'none'} platform_net_amount=${platformNetAmountPence} ` +
    `charge_id=${chargeId ?? 'none'} payment_intent_id=${paymentIntentId} transfer_id=${transferId ?? 'none'} ` +
    `application_fee_id=${applicationFeeId ?? 'none'} application_fee_balance_transaction_id=${applicationFeeBalanceTransactionId ?? 'none'} ` +
    `connected_account_id=${destinationAccountId ?? 'none'} transfer_reversal_id=${transferReversalId ?? 'none'} warning=${settlementWarning ?? 'none'}`,
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
    effectiveDriverTransferAmountPence,
    platformNetAmountPence,
    transferReversalId,
    applicationFeeBalanceTransactionId,
    settlementMode,
    settlementVerified,
    settlementWarning,
  };
}