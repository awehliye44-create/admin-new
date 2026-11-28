/** Offline test/audit-only helpers; not part of Edge uploads. */
import { OPERATIONAL_RESERVE_ERROR } from "../../../functions/_shared/companyOperationalReserveSSOT.ts";
/**
 * Slice 10 — Operational / Refund Reserve SSOT + final company funds gate.
 *
 * Configuration never moves money. Client must not invent reserve amounts —
 * only ACTIVE backend policy unlocks final_company_available.
 *
 * Until ACTIVE policy: reserve NOT_CONFIGURED, final Available UNAVAILABLE,
 * company transfer execution BLOCKED. Never fall back to zero reserve silently.
 */

export const SLICE10 = 10 as const;


/** Proven money state — do not mutate (Slice 7–9 PASS). */
export const SLICE10_PROOF = {
  SOURCE_PENCE: 1526,
  LIABILITY_PENCE: 1001,
  RESERVED_PENCE: 1001,
  BEFORE_RESERVE_PENCE: 525,
  NET_COMMISSION_PENCE: 172,
  UNCLASSIFIED_PENCE: 353,
  APPROVED_PAYABLES_PENCE: 0,
} as const;


/**
 * classified_company_cash = recognised_net_commission + other explicitly classified funding.
 * UNATTRIBUTED / RECONCILIATION_REQUIRED never included.
 */
export function computeClassifiedCompanyCashPence(args: {
  recognised_net_commission_pence: number | null | undefined;
  other_classified_funding_pence?: number | null;
}): number | null {
  if (args.recognised_net_commission_pence == null) return null;
  return Math.max(0, Math.round(Number(args.recognised_net_commission_pence)))
    + Math.max(0, Math.round(Number(args.other_classified_funding_pence ?? 0)));
}


/** Explicit company-transfer gate reasons (never source / protected / gross / unclassified). */
export function assertFinalCompanyTransferAllowed(args: {
  final_company_available_pence: number | null | undefined;
  amount_pence?: number | null;
  reserve_reason_code?: string | null;
}): void {
  if (args.final_company_available_pence == null) {
    throw new Error(
      args.reserve_reason_code
        || OPERATIONAL_RESERVE_ERROR.TRANSFER_BLOCKED,
    );
  }
  const amount = args.amount_pence == null ? null : Number(args.amount_pence);
  if (amount != null && amount > args.final_company_available_pence) {
    throw new Error(OPERATIONAL_RESERVE_ERROR.TRANSFER_BLOCKED);
  }
}

export * from "../../../functions/_shared/companyOperationalReserveSSOT.ts";
export * from "../../../../shared/edgePresentation/companyOperationalReserveSSOT.ts";
