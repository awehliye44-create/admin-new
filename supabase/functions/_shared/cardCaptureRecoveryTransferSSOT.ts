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

