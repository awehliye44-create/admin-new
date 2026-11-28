

/** Net card earnings transferred after recovery debt offset. */
export function computeDriverProviderTransferAmountPence(args: {
  driverNetPence: number;
  outstandingRecoveryDebtPence: number;
}): number {
  const driverNet = Math.max(0, Math.round(args.driverNetPence));
  const outstanding = Math.max(0, Math.round(args.outstandingRecoveryDebtPence));
  return Math.max(0, driverNet - outstanding);
}

