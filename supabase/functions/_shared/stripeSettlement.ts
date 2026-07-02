import Stripe from "npm:stripe@18.5.0";
import {
  computeDriverStripeTransferAmountPence,
  computePerTripDebtRecoveryPence,
  computeRemainingRecoveryDebtPence,
} from "./cardCaptureRecoveryTransferSSOT.ts";
import { computeCashCommissionOutstanding } from "./onecabFinanceLedger.ts";

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
  debtRecoveryPence: number;
  remainingRecoveryDebtPence: number;
  driverNetPence: number | null;
}

function resolveCardCaptureDriverTransferPence(args: {
  captureAmountPence: number;
  commissionPence: number;
  driverNetPence?: number | null;
  outstandingRecoveryDebtPence?: number | null;
  passThroughPence?: number | null;
  tipPence?: number | null;
}): {
  driverTransferAmountPence: number;
  debtRecoveryPence: number;
  remainingRecoveryDebtPence: number;
  driverNetPence: number | null;
} {
  const fallbackGross = Math.max(0, args.captureAmountPence - args.commissionPence);
  if (args.driverNetPence == null) {
    return {
      driverTransferAmountPence: fallbackGross,
      debtRecoveryPence: 0,
      remainingRecoveryDebtPence: Math.max(0, args.outstandingRecoveryDebtPence ?? 0),
      driverNetPence: null,
    };
  }

  const driverNetPence = Math.max(0, Math.round(args.driverNetPence));
  const outstandingRecoveryDebtPence = Math.max(0, Math.round(args.outstandingRecoveryDebtPence ?? 0));
  const passThroughPence = Math.max(0, Math.round(args.passThroughPence ?? 0));
  const tipPence = Math.max(0, Math.round(args.tipPence ?? 0));
  const debtRecoveryPence = computePerTripDebtRecoveryPence({
    outstandingRecoveryDebtPence,
    driverNetPence,
  });
  const remainingRecoveryDebtPence = computeRemainingRecoveryDebtPence({
    outstandingRecoveryDebtPence,
    driverNetPence,
  });
  const netTransferPence = computeDriverStripeTransferAmountPence({
    driverNetPence,
    outstandingRecoveryDebtPence,
  });

  return {
    driverTransferAmountPence: netTransferPence + passThroughPence + tipPence,
    debtRecoveryPence,
    remainingRecoveryDebtPence,
    driverNetPence,
  };
}

export type CardCaptureRecoverySettlementArgs = {
  driverNetPence: number;
  outstandingRecoveryDebtPence: number;
  passThroughPence: number;
  tipPence: number;
};

export async function loadDriverOutstandingRecoveryDebtPence(
  supabase: SupabaseLike,
  driverId: string,
): Promise<number> {
  const { data: ledgerRows } = await supabase
    .from("driver_wallet_ledger")
    .select("type, amount_pence")
    .eq("driver_id", driverId);
  return computeCashCommissionOutstanding(ledgerRows ?? []);
}

export function buildCardCaptureRecoverySettlementArgs(args: {
  driverNetPence: number;
  outstandingRecoveryDebtPence: number;
  airportChargePence?: number;
  otherPassThroughChargesPence?: number;
  tipPence?: number;
}): CardCaptureRecoverySettlementArgs {
  return {
    driverNetPence: Math.max(0, Math.round(args.driverNetPence)),
    outstandingRecoveryDebtPence: Math.max(0, Math.round(args.outstandingRecoveryDebtPence)),
    passThroughPence:
      Math.max(0, Math.round(args.airportChargePence ?? 0))
      + Math.max(0, Math.round(args.otherPassThroughChargesPence ?? 0)),
    tipPence: Math.max(0, Math.round(args.tipPence ?? 0)),
  };
}

export function persistedStripeDriverTransferAmountPence(
  settlement: Pick<StripeSettlementResult, "effectiveDriverTransferAmountPence" | "transferAmountPence">,
): number | null {
  if (settlement.effectiveDriverTransferAmountPence != null) {
    return settlement.effectiveDriverTransferAmountPence;
  }
  return settlement.transferAmountPence;
}

function verifySeparateChargeTransferSettlement(args: {
  driverTransferAmountPence: number;
  transferAmountPence: number | null;
  transferId: string | null;
  destinationAccountId: string | null;
}): boolean {
  if ((args.transferAmountPence ?? 0) !== args.driverTransferAmountPence) return false;
  if (args.driverTransferAmountPence === 0) {
    return !args.transferId;
  }
  return !!args.transferId && !!args.destinationAccountId;
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
  driverNetPence = null,
  outstandingRecoveryDebtPence = null,
  passThroughPence = null,
  tipPence = null,
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
  driverNetPence?: number | null;
  outstandingRecoveryDebtPence?: number | null;
  passThroughPence?: number | null;
  tipPence?: number | null;
}): Promise<StripeSettlementResult> {
  let paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
  if (paymentIntent.status !== 'requires_capture') {
    throw new Error(`Cannot capture — PaymentIntent status is "${paymentIntent.status}"`);
  }

  if (commissionPence < 0 || commissionPence > captureAmountPence) {
    throw new Error(`Invalid commission for Stripe settlement: commission=${commissionPence} capture=${captureAmountPence}`);
  }

  const transferResolution = resolveCardCaptureDriverTransferPence({
    captureAmountPence,
    commissionPence,
    driverNetPence,
    outstandingRecoveryDebtPence,
    passThroughPence,
    tipPence,
  });
  const expectedDriverTransferAmountPence = Math.max(0, captureAmountPence - commissionPence);
  const driverTransferAmountPence = transferResolution.driverTransferAmountPence;
  const debtRecoveryPence = transferResolution.debtRecoveryPence;
  const remainingRecoveryDebtPence = transferResolution.remainingRecoveryDebtPence;
  if (driverPayoutPence !== expectedDriverTransferAmountPence && driverPayoutPence !== driverTransferAmountPence) {
    console.warn(
      `[stripe-settlement] driver payout override ignored for trip=${tripId}; ` +
      `requested=${driverPayoutPence}p gross=${expectedDriverTransferAmountPence}p ` +
      `recovery_adjusted=${driverTransferAmountPence}p debt_recovery=${debtRecoveryPence}p`,
    );
  }

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

  // Platform preauth PIs are created without transfer_data.destination (driver unknown at
  // booking). Stripe API 2025-08-27.basil rejects transfer_data[destination] on both PI
  // update and capture for those intents — destination charges must be set at PI create.
  // Use separate charge + post-capture transfer when the PI has no destination yet.
  if (!destinationAccountId && resolvedDriverAccountId) {
    console.log(
      `[stripe-settlement] PI ${paymentIntentId} has no Connect destination; ` +
      `will capture on platform and transfer ${driverTransferAmountPence}p to ${resolvedDriverAccountId}`,
    );
  }

  const captureParams: Stripe.PaymentIntentCaptureParams = {
    amount_to_capture: captureAmountPence,
    metadata: {
      trip_id: tripId,
      final_fare_pence: String(captureAmountPence),
      commission_pence: String(commissionPence),
      driver_transfer_amount: String(driverTransferAmountPence),
      debt_recovery_pence: String(debtRecoveryPence),
      remaining_recovery_debt_pence: String(remainingRecoveryDebtPence),
      connected_account_id: destinationAccountId ?? resolvedDriverAccountId ?? 'none',
      platform_account_id: platformAccountId ?? 'unknown',
      settlement_mode: destinationAccountId ? 'destination_charge' : resolvedDriverAccountId ? 'separate_charge_transfer' : 'platform_charge_only',
    },
  };

  // application_fee_amount on capture only works for destination charges where the PI
  // already has transfer_data.destination from create — never pass transfer_data here.
  if (destinationAccountId && commissionPence > 0) {
    captureParams.application_fee_amount = commissionPence;
  }

  console.log(
    `[stripe-settlement] trip=${tripId} pi=${paymentIntentId} final_fare_pence=${captureAmountPence} commission_pence=${commissionPence} ` +
    `driver_transfer_amount=${driverTransferAmountPence} debt_recovery_pence=${debtRecoveryPence} ` +
    `remaining_recovery_debt_pence=${remainingRecoveryDebtPence} application_fee_amount=${captureParams.application_fee_amount ?? 'none'} ` +
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

  // Post-capture fallback: platform-only or botched destination capture with no fee/transfer on charge.
  if (!applicationFeeId && !transferId && resolvedDriverAccountId && chargeId && driverTransferAmountPence > 0) {
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

    if (debtRecoveryPence > 0 && transferId) {
      const recoveryReversal = await stripe.transfers.createReversal(
        transferId,
        {
          amount: debtRecoveryPence,
          metadata: {
            trip_id: tripId,
            payment_intent_id: paymentIntentId,
            reason: 'recovery_debt_offset_before_connect_transfer',
            debt_recovery_pence: String(debtRecoveryPence),
            remaining_recovery_debt_pence: String(remainingRecoveryDebtPence),
          },
        },
        { idempotencyKey: `${idempotencyKey}_recovery_debt_reversal` },
      );
      effectiveDriverTransferAmountPence = Math.max(
        0,
        (effectiveDriverTransferAmountPence ?? 0) - recoveryReversal.amount,
      );
      console.log(
        `[stripe-settlement] recovery debt offset; reversed ${recoveryReversal.amount}p from transfer=${transferId} ` +
        `remaining_recovery_debt_pence=${remainingRecoveryDebtPence}`,
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
    settlementVerified = verifySeparateChargeTransferSettlement({
      driverTransferAmountPence,
      transferAmountPence,
      transferId,
      destinationAccountId,
    });
    settlementWarning = settlementVerified
      ? 'SEPARATE_CHARGE_TRANSFER_USED_NO_APPLICATION_FEE_OBJECT'
      : `SEPARATE_TRANSFER_MISMATCH expected=${driverTransferAmountPence} actual=${transferAmountPence ?? 'none'}`;
  } else {
    settlementVerified = commissionPence === 0;
    settlementWarning = commissionPence > 0
      ? 'NO_DRIVER_CONNECT_ACCOUNT_PLATFORM_RETAINED_FULL_CHARGE_MANUAL_PAYOUT_REQUIRED'
      : 'NO_DRIVER_CONNECT_ACCOUNT_NO_COMMISSION';
  }

  if (resolvedDriverAccountId && driverTransferAmountPence > 0 && !settlementVerified) {
    throw new Error(
      `STRIPE_SETTLEMENT_NOT_VERIFIED: trip=${tripId} pi=${paymentIntentId} mode=${settlementMode} ` +
      `warning=${settlementWarning ?? 'none'}`,
    );
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

  if (effectiveDriverTransferAmountPence == null) {
    effectiveDriverTransferAmountPence = driverTransferAmountPence;
  }

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
    debtRecoveryPence,
    remainingRecoveryDebtPence,
    driverNetPence: transferResolution.driverNetPence,
  };
}

export type TripSettlementColumnUpdate = {
  stripe_charge_id: string | null;
  stripe_application_fee_id: string | null;
  stripe_application_fee_amount_pence: number | null;
  stripe_destination_account_id: string | null;
  stripe_transfer_id: string | null;
  stripe_transfer_amount_pence: number | null;
  stripe_settlement_verified: boolean;
  stripe_settlement_warning: string | null;
  debt_recovery_pence: number;
};

export function tripSettlementColumnsFromResult(
  settlement: Pick<
    StripeSettlementResult,
    | 'chargeId'
    | 'applicationFeeId'
    | 'applicationFeeAmountPence'
    | 'destinationAccountId'
    | 'transferId'
    | 'transferAmountPence'
    | 'effectiveDriverTransferAmountPence'
    | 'settlementVerified'
    | 'settlementWarning'
    | 'debtRecoveryPence'
  >,
): TripSettlementColumnUpdate {
  return {
    stripe_charge_id: settlement.chargeId,
    stripe_application_fee_id: settlement.applicationFeeId,
    stripe_application_fee_amount_pence: settlement.applicationFeeAmountPence,
    stripe_destination_account_id: settlement.destinationAccountId,
    stripe_transfer_id: settlement.transferId,
    stripe_transfer_amount_pence: persistedStripeDriverTransferAmountPence(settlement),
    stripe_settlement_verified: settlement.settlementVerified,
    stripe_settlement_warning: settlement.settlementWarning,
    debt_recovery_pence: settlement.debtRecoveryPence,
  };
}

/**
 * Recovery path when the PaymentIntent is already `succeeded` but the charge has
 * no application_fee and no Connect transfer (legacy platform-only capture).
 */
export async function ensureStripeSettlementForCapturedPayment({
  stripe,
  supabase,
  tripId,
  driverId,
  paymentIntentId,
  commissionPence,
  driverPayoutPence,
  currencyCode,
  driverStripeAccountId,
  idempotencyKey,
  driverNetPence = null,
  outstandingRecoveryDebtPence = null,
  passThroughPence = null,
  tipPence = null,
}: {
  stripe: Stripe;
  supabase?: SupabaseLike;
  tripId: string;
  driverId?: string | null;
  paymentIntentId: string;
  commissionPence: number;
  driverPayoutPence: number;
  currencyCode: string;
  driverStripeAccountId?: string | null;
  idempotencyKey: string;
  driverNetPence?: number | null;
  outstandingRecoveryDebtPence?: number | null;
  passThroughPence?: number | null;
  tipPence?: number | null;
}): Promise<StripeSettlementResult> {
  const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
  if (paymentIntent.status !== 'succeeded') {
    throw new Error(`Cannot ensure settlement — PaymentIntent status is "${paymentIntent.status}"`);
  }

  let resolvedDriverAccountId = driverStripeAccountId ?? null;
  if (!resolvedDriverAccountId && driverId && supabase) {
    const { data: driver } = await supabase
      .from('drivers')
      .select('stripe_account_id')
      .eq('id', driverId)
      .maybeSingle();
    resolvedDriverAccountId = driver?.stripe_account_id ?? null;
  }

  let destinationAccountId = asStripeId(paymentIntent.transfer_data?.destination) ?? resolvedDriverAccountId;
  const chargeId = asStripeId(paymentIntent.latest_charge);
  if (!chargeId) {
    throw new Error(`Cannot ensure settlement — PaymentIntent ${paymentIntentId} has no charge`);
  }

  const charge = await stripe.charges.retrieve(chargeId, {
    expand: ['balance_transaction', 'application_fee', 'transfer'],
  });

  let capturedAmountPence = charge.amount_captured ?? charge.amount;
  const transferResolution = resolveCardCaptureDriverTransferPence({
    captureAmountPence: capturedAmountPence,
    commissionPence,
    driverNetPence,
    outstandingRecoveryDebtPence,
    passThroughPence,
    tipPence,
  });
  const driverTransferAmountPence = transferResolution.driverTransferAmountPence;
  const debtRecoveryPence = transferResolution.debtRecoveryPence;
  const remainingRecoveryDebtPence = transferResolution.remainingRecoveryDebtPence;
  let stripeFeePence = 0;
  const balanceTransaction = charge.balance_transaction;
  if (balanceTransaction && typeof balanceTransaction === 'object' && 'fee' in balanceTransaction) {
    stripeFeePence = (balanceTransaction as Stripe.BalanceTransaction).fee ?? 0;
  }

  let applicationFeeId = asStripeId(charge.application_fee);
  let applicationFeeAmountPence = asStripeAmount(charge.application_fee);
  let transferId = asStripeId((charge as unknown as { transfer?: unknown }).transfer);
  let transferAmountPence = asStripeAmount((charge as unknown as { transfer?: unknown }).transfer);
  let effectiveDriverTransferAmountPence: number | null = null;
  let transferReversalId: string | null = null;
  let applicationFeeBalanceTransactionId: string | null = null;

  if (applicationFeeId) {
    try {
      const applicationFee = await stripe.applicationFees.retrieve(applicationFeeId, { expand: ['balance_transaction'] });
      applicationFeeAmountPence = applicationFee.amount ?? applicationFeeAmountPence;
      applicationFeeBalanceTransactionId = asStripeId(applicationFee.balance_transaction);
    } catch (error) {
      console.warn(`[stripe-settlement-recovery] Could not retrieve application fee ${applicationFeeId}: ${(error as Error).message}`);
    }
  }

  let settlementMode: StripeSettlementResult['settlementMode'] = destinationAccountId && applicationFeeId
    ? 'destination_charge'
    : transferId
      ? 'separate_charge_transfer'
      : resolvedDriverAccountId
        ? 'separate_charge_transfer'
        : 'platform_charge_only';

  if (!applicationFeeId && !transferId && resolvedDriverAccountId && driverTransferAmountPence > 0) {
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
          settlement_recovery: 'post_capture_webhook_or_finalize',
          commission_pence: String(commissionPence),
        },
      },
      { idempotencyKey: `${idempotencyKey}_recovery_transfer` },
    );

    destinationAccountId = resolvedDriverAccountId;
    transferId = transfer.id;
    transferAmountPence = transfer.amount;
    effectiveDriverTransferAmountPence = transfer.amount;
    settlementMode = 'separate_charge_transfer';
    console.warn(`[stripe-settlement-recovery] Created missing transfer ${transfer.id} for ${transfer.amount}p trip=${tripId}`);
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
            reason: 'recovery_missing_or_partial_application_fee',
            expected_commission_pence: String(commissionPence),
            existing_application_fee_pence: String(applicationFeeAmountPence ?? 0),
          },
        },
        { idempotencyKey: `${idempotencyKey}_recovery_reversal` },
      );
      transferReversalId = reversal.id;
      effectiveDriverTransferAmountPence = Math.max(0, effectiveDriverTransferAmountPence - reversal.amount);
    }

    if (debtRecoveryPence > 0 && transferId) {
      const recoveryReversal = await stripe.transfers.createReversal(
        transferId,
        {
          amount: debtRecoveryPence,
          metadata: {
            trip_id: tripId,
            payment_intent_id: paymentIntentId,
            reason: 'recovery_debt_offset_before_connect_transfer',
            debt_recovery_pence: String(debtRecoveryPence),
            remaining_recovery_debt_pence: String(remainingRecoveryDebtPence),
          },
        },
        { idempotencyKey: `${idempotencyKey}_recovery_debt_reversal` },
      );
      effectiveDriverTransferAmountPence = Math.max(
        0,
        (effectiveDriverTransferAmountPence ?? 0) - recoveryReversal.amount,
      );
      console.log(
        `[stripe-settlement-recovery] recovery debt offset; reversed ${recoveryReversal.amount}p from transfer=${transferId} ` +
        `remaining_recovery_debt_pence=${remainingRecoveryDebtPence}`,
      );
    }
  } else if (settlementMode === 'separate_charge_transfer' && transferAmountPence != null) {
    effectiveDriverTransferAmountPence = transferAmountPence;
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
    settlementVerified = verifySeparateChargeTransferSettlement({
      driverTransferAmountPence,
      transferAmountPence,
      transferId,
      destinationAccountId,
    });
    settlementWarning = settlementVerified
      ? 'SEPARATE_CHARGE_TRANSFER_USED_NO_APPLICATION_FEE_OBJECT'
      : `SEPARATE_TRANSFER_MISMATCH expected=${driverTransferAmountPence} actual=${transferAmountPence ?? 'none'}`;
  } else {
    settlementVerified = commissionPence === 0;
    settlementWarning = commissionPence > 0
      ? 'NO_DRIVER_CONNECT_ACCOUNT_PLATFORM_RETAINED_FULL_CHARGE_MANUAL_PAYOUT_REQUIRED'
      : 'NO_DRIVER_CONNECT_ACCOUNT_NO_COMMISSION';
  }

  if (resolvedDriverAccountId && driverTransferAmountPence > 0 && !settlementVerified) {
    throw new Error(
      `STRIPE_SETTLEMENT_RECOVERY_FAILED: trip=${tripId} pi=${paymentIntentId} mode=${settlementMode} ` +
      `warning=${settlementWarning ?? 'none'}`,
    );
  }

  console.log(
    `[stripe-settlement-recovery] verified=${settlementVerified} mode=${settlementMode} trip=${tripId} ` +
    `charge=${chargeId} transfer=${transferId ?? 'none'} app_fee=${applicationFeeId ?? 'none'}`,
  );

  if (effectiveDriverTransferAmountPence == null) {
    effectiveDriverTransferAmountPence = driverTransferAmountPence;
  }

  return {
    capturedPaymentIntent: paymentIntent,
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
    debtRecoveryPence,
    remainingRecoveryDebtPence,
    driverNetPence: transferResolution.driverNetPence,
  };
}
