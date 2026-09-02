/**
 * Company-balance composition inputs for transfer funding gates.
 * Matches admin-payout-ledger company_list loaders — never invent £0 on query failure.
 */
export {
  loadProtectedDriverLiabilitiesPence,
  loadProtectedDriverLiabilityPence,
  loadReservedDriverPayoutPence,
  type ProtectedDriverLiabilityBreakdown,
} from "./loadProtectedDriverLiabilitiesSSOT.ts";
