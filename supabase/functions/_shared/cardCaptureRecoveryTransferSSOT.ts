/**
 * Card capture → recovery debt → provider transfer SSOT.
 *
 * For card trips:
 *   Driver Net = final_fare_pence − commission_pence
 *   Driver provider transfer (net portion) = MAX(0, Driver Net − Outstanding Recovery Debt)
 *   Remaining Recovery Debt = MAX(0, Outstanding Recovery Debt − Driver Net)
 *
 * Pass-through charges (airport, etc.) and tips are not reduced by recovery debt.
 */

export type CardCaptureRecoveryTransferResult = {
  driver_net_pence: number;
  debt_recovery_pence: number;
  remaining_recovery_debt_pence: number;
  driver_provider_transfer_net_pence: number;
  driver_provider_transfer_total_pence: number;
};

export function computeCardDriverNetPence(
  finalFarePence: number,
  commissionPence: number,
): number {
  return Math.max(0, Math.round(finalFarePence) - Math.round(commissionPence));
}

export function computePerTripDebtRecoveryPence(args: {
  outstandingRecoveryDebtPence: number;
  driverNetPence: number;
}): number {
  const outstanding = Math.max(0, Math.round(args.outstandingRecoveryDebtPence));
  const driverNet = Math.max(0, Math.round(args.driverNetPence));
  return Math.min(outstanding, driverNet);
}

export function computeRemainingRecoveryDebtPence(args: {
  outstandingRecoveryDebtPence: number;
  driverNetPence: number;
}): number {
  const outstanding = Math.max(0, Math.round(args.outstandingRecoveryDebtPence));
  const driverNet = Math.max(0, Math.round(args.driverNetPence));
  return Math.max(0, outstanding - driverNet);
}

/** Net card earnings transferred after recovery debt offset. */
export function computeDriverProviderTransferAmountPence(args: {
  driverNetPence: number;
  outstandingRecoveryDebtPence: number;
}): number {
  const driverNet = Math.max(0, Math.round(args.driverNetPence));
  const outstanding = Math.max(0, Math.round(args.outstandingRecoveryDebtPence));
  return Math.max(0, driverNet - outstanding);
}

export function computeCardCaptureRecoveryTransfer(args: {
  finalFarePence: number;
  commissionPence: number;
  outstandingRecoveryDebtPence: number;
  passThroughPence?: number;
  tipPence?: number;
}): CardCaptureRecoveryTransferResult {
  const driverNetPence = computeCardDriverNetPence(args.finalFarePence, args.commissionPence);
  const debtRecoveryPence = computePerTripDebtRecoveryPence({
    outstandingRecoveryDebtPence: args.outstandingRecoveryDebtPence,
    driverNetPence,
  });
  const remainingRecoveryDebtPence = computeRemainingRecoveryDebtPence({
    outstandingRecoveryDebtPence: args.outstandingRecoveryDebtPence,
    driverNetPence,
  });
  const driverProviderTransferNetPence = computeDriverProviderTransferAmountPence({
    driverNetPence,
    outstandingRecoveryDebtPence: args.outstandingRecoveryDebtPence,
  });
  const passThroughPence = Math.max(0, Math.round(args.passThroughPence ?? 0));
  const tipPence = Math.max(0, Math.round(args.tipPence ?? 0));
  const driverProviderTransferTotalPence =
    driverProviderTransferNetPence + passThroughPence + tipPence;

  return {
    driver_net_pence: driverNetPence,
    debt_recovery_pence: debtRecoveryPence,
    remaining_recovery_debt_pence: remainingRecoveryDebtPence,
    driver_provider_transfer_net_pence: driverProviderTransferNetPence,
    driver_provider_transfer_total_pence: driverProviderTransferTotalPence,
  };
}
