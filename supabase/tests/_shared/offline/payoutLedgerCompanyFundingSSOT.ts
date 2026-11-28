/** Offline test/audit-only helpers; not part of Edge uploads. */
/**
 * Payout Ledger company-funding card rollups (pure).
 * Never mutates wallets / reservations / provider payments.
 */
import {
  computeProtectedDriverLiabilitiesPence,
} from "../../../functions/_shared/protectedDriverLiabilitiesSSOT.ts";

import { COMPANY_BALANCE_LABELS } from "../../../functions/_shared/companyBalanceSSOT.ts";


export const SLICE8_FUNDING_PROOF = {
  AHMED_ID: "5ed232c3-8bb5-4085-95d6-73e48e6c5e28",
  AHMED_LIVE_PENCE: 1001,
  AHMED_RESERVED_PENCE: 1001,
  BOSTEYO_ID: "cd8bae4c-3827-4b90-98c6-10be70eb0e52",
  BOSTEYO_COMPLETED_PENCE: 408,
  REVOLUT_SOURCE_PENCE: 1526,
  EXPECTED_LIABILITY_PENCE: 1001,
  EXPECTED_RESERVED_PENCE: 1001,
  EXPECTED_COMPLETED_MONTH_PENCE: 408,
  EXPECTED_AVAILABLE_PENCE: 525,
  /** Payment Sessions SSOT canonical net commission (consume — never recalc gross/fees). */
  EXPECTED_NET_COMMISSION_PENCE: 172,
  /** before_reserve − net_commission when residue is unclassified. */
  EXPECTED_OTHER_COMPANY_CASH_PENCE: 353,
} as const;


/** @deprecated Use computeProtectedDriverLiabilitiesPence — live-only rollup for legacy tests. */
export function sumProtectedDriverLiabilitiesPence(
  liveByDriver: ReadonlyArray<{ driver_id: string; live_pence: number }>,
): number {
  return computeProtectedDriverLiabilitiesPence(
    liveByDriver.map((row) => ({
      driver_id: row.driver_id,
      live_wallet_pence: row.live_pence,
    })),
  ).total_pence;
}


/** Reserved = sum(ACTIVE driver_payout_reservations.amount_pence) only. */
export function sumActiveReservedDriverPayoutsPence(
  reservations: ReadonlyArray<{
    driver_id: string;
    amount_pence: number;
    status: string;
  }>,
): number {
  let total = 0;
  for (const row of reservations) {
    if (String(row.status ?? "").toUpperCase() !== "ACTIVE") continue;
    total += Math.max(0, Math.round(Number(row.amount_pence ?? 0)));
  }
  return total;
}

export * from "../../../functions/_shared/payoutLedgerCompanyFundingSSOT.ts";
