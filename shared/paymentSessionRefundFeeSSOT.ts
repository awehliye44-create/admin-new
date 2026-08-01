/** Minimal SSOT helpers for payment-session refund totals + fee classification. */
export const FEE_STATUS = {
  ACTUAL: "ACTUAL",
  PENDING: "PENDING",
  UNAVAILABLE: "UNAVAILABLE",
} as const;

export type FeeStatus = (typeof FEE_STATUS)[keyof typeof FEE_STATUS];

export function sumRefundChildrenPence(
  rows: Array<{ amount_pence?: unknown }> | null | undefined,
): number | null {
  if (!rows || rows.length === 0) return null;
  let total = 0;
  let any = false;
  for (const row of rows) {
    const n = Number(row?.amount_pence);
    if (!Number.isFinite(n) || n <= 0) continue;
    total += Math.trunc(n);
    any = true;
  }
  return any ? total : null;
}

export function classifyFeeStatus(args: {
  providerFeePence: number | null | undefined;
  retrieveSucceeded?: boolean;
}): {
  provider_processing_fee_pence: number | null;
  fee_status: FeeStatus;
} {
  const fee = args.providerFeePence == null ? null : Number(args.providerFeePence);
  if (fee != null && Number.isFinite(fee) && fee > 0) {
    return {
      provider_processing_fee_pence: Math.trunc(fee),
      fee_status: FEE_STATUS.ACTUAL,
    };
  }
  if (args.retrieveSucceeded === false) {
    return {
      provider_processing_fee_pence: null,
      fee_status: FEE_STATUS.UNAVAILABLE,
    };
  }
  return {
    provider_processing_fee_pence: null,
    fee_status: FEE_STATUS.PENDING,
  };
}
