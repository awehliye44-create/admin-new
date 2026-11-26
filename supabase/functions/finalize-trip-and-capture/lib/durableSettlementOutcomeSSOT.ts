/**
 * Re-export canonical durable settlement SSOT from _shared.
 * HTTP finalize and same-isolate tip-window finalize must share one map.
 */
export {
  durableSettlementColumns,
  needsDurableSettlementPersist,
  persistDurableSettlementOutcome,
  persistDurableSettlementOutcomeIfNeeded,
  type DurableSettlementColumns,
} from "../../_shared/durableSettlementOutcomeSSOT.ts";
