/** Offline test/audit-only helpers; not part of Edge uploads. */
/**
 * Backend-owned fare-increase payment + atomic apply.
 *
 * FARE → MONEY PROTECTION → TRIP mutation.
 * Customer App may display progress; it must not be the financial orchestrator.
 *
 * PLATFORM_COLLECTED only. DRIVER_COLLECTED must not enter Revolut increment.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";

import {
  fetchTripAndBroadcastUpdated,
  invokePreauthUpdateOnModification,
  upsertTripRoutePolyline,
} from "../../../functions/_shared/tripModificationApply.ts";

import {
  canPendingOverwriteModificationRequestStatus,
  classifyModificationPaymentFailure,
  decideFromPreauthInvokeResult,
  gateFromTerminalAuthorisationStatus,
  isAlreadyAppliedModification,
  TERMINAL_ADDITIONAL_AUTHORISATION_STATUSES,
  type ModificationPaymentGateDecision,
} from "../../../functions/_shared/tripModificationPaymentGateSSOT.ts";

import { SERVICE_AREA_FINANCIAL_MODEL } from "../../../functions/_shared/commissionWalletSSOT.ts";

import { TRIP_CHANGE_BANK_DECLINED_CUSTOMER_MESSAGE } from "../../../functions/_shared/revolutCustomerError.ts";

import {
  failureClassForModificationFailure,
  type ModificationPaymentFailureClass,
} from "../../../functions/_shared/modificationPaymentFailureTaxonomy.ts";

import {
  MODIFICATION_CHALLENGE_UNSUPPORTED_CUSTOMER_MESSAGE,
  MODIFICATION_CHALLENGE_UNSUPPORTED_REJECTION,
  MODIFICATION_UNCHANGED_CUSTOMER_MESSAGE,
  revisedPayablePenceForModification,
} from "../../../functions/_shared/modificationHoldLivenessSSOT.ts";

import { upsertModificationUnchangedNotice } from "../../../functions/_shared/customerPaymentFailureNoticeSSOT.ts";

import { writePayableSnapshotOrLog } from "../../../functions/_shared/writePayableSnapshotOrLogSSOT.ts";


export function resolveCommittedCustomerPayablePence(trip: Record<string, unknown>): number {
  const finalCust = Math.round(Number(trip.final_customer_fare_pence ?? 0));
  const finalFare = Math.round(Number(trip.final_fare_pence ?? 0));
  const estimated = Math.round(Number(trip.estimated_total_pence ?? 0));
  const locked = Math.round(Number(trip.locked_base_fare_pence ?? 0));
  return Math.max(0, finalCust, finalFare, estimated, locked);
}

export * from "../../../functions/_shared/executeFareIncreaseModificationPayment.ts";
