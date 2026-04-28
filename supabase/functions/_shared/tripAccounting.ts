/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  LOCKED MODULE — Trip Accounting Invariants                     ║
 * ║                                                                ║
 * ║  NON-NEGOTIABLE RULES:                                         ║
 * ║  1. Commission is based on driver tier (snapshotted per trip)   ║
 * ║  2. commission_pence = fare × tier_commission_pct (GROSS,       ║
 * ║     before Stripe fee). NEVER reduced by Stripe fee.            ║
 * ║  3. Stripe fee is tracked SEPARATELY on the trip as              ║
 * ║     stripe_processing_fee_pence (from balance_transaction).     ║
 * ║     ONECAB net = commission_pence - stripe_processing_fee_pence  ║
 * ║     and is reported separately — never deducted from driver.     ║
 * ║  4. Tips are NOT part of fare — NEVER commissioned              ║
 * ║  5. driver_net = fare - commission (tips added separately)      ║
 * ║  6. Card trip → wallet += driver_net + tips                     ║
 * ║  7. Cash trip → wallet -= commission only                       ║
 * ║  8. NEVER recalculate after settlement                          ║
 * ║  9. NEVER change past settled trips                             ║
 * ║  10. UI NEVER performs financial calculations                   ║
 * ║                                                                ║
 * ║  Protected by: src/test/tripAccounting.test.ts                  ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */
export interface TripAccountingInput {
  commissionableSubtotalPence: number;
  commissionPence: number;
  tipAmountPence?: number;
}

export interface TripAccountingValidationInput extends TripAccountingInput {
  driverNetBeforeTipPence: number;
  driverTotalEarningsPence: number;
  finalTripTotalPence: number;
}

export interface TripAccountingBreakdown {
  driverNetBeforeTipPence: number;
  driverTotalEarningsPence: number;
  finalTripTotalPence: number;
}

export function buildTripAccounting({
  commissionableSubtotalPence,
  commissionPence,
  tipAmountPence = 0,
}: TripAccountingInput): TripAccountingBreakdown {
  const driverNetBeforeTipPence = commissionableSubtotalPence - commissionPence;
  const finalTripTotalPence = commissionableSubtotalPence + tipAmountPence;
  const driverTotalEarningsPence = driverNetBeforeTipPence + tipAmountPence;

  return {
    driverNetBeforeTipPence,
    driverTotalEarningsPence,
    finalTripTotalPence,
  };
}

export function validateTripAccounting({
  commissionableSubtotalPence,
  commissionPence,
  tipAmountPence = 0,
  driverNetBeforeTipPence,
  driverTotalEarningsPence,
  finalTripTotalPence,
}: TripAccountingValidationInput): string | null {
  const values = [
    commissionableSubtotalPence,
    commissionPence,
    tipAmountPence,
    driverNetBeforeTipPence,
    driverTotalEarningsPence,
    finalTripTotalPence,
  ];

  if (values.some((value) => !Number.isInteger(value) || value < 0)) {
    return 'Trip accounting values must be non-negative integers';
  }

  if (commissionPence > commissionableSubtotalPence) {
    return 'commissionPence cannot exceed commissionableSubtotalPence';
  }

  if (driverNetBeforeTipPence !== commissionableSubtotalPence - commissionPence) {
    return 'driverNetBeforeTipPence must equal commissionableSubtotalPence - commissionPence';
  }

  if (finalTripTotalPence !== commissionableSubtotalPence + tipAmountPence) {
    return 'finalTripTotalPence must equal commissionableSubtotalPence + tipAmountPence';
  }

  if (driverTotalEarningsPence !== driverNetBeforeTipPence + tipAmountPence) {
    return 'driverTotalEarningsPence must equal driverNetBeforeTipPence + tipAmountPence';
  }

  return null;
}