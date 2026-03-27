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