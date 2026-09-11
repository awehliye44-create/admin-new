/**
 * A8B28F-B2R — draft path retained as thin re-export of live UK payload SSOT.
 * Live wiring: supabase/functions/_shared/revolutUkDriverCounterpartyPayload.ts
 * via createRevolutCounterparty (uk_bank_account).
 */
export {
  buildUkDriverRevolutCounterpartyBody,
  detectUkDriverCounterpartyKind,
  digitsOnly,
  normalizeUkAccountHolderName,
  splitIndividualName,
  type UkDriverCounterpartyKind,
} from "../../functions/_shared/revolutUkDriverCounterpartyPayload.ts";
