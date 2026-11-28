/** Offline test/audit-only helpers; not part of Edge uploads. */
/**
 * Payment session SSOT — persisted booking attempt before checkout.
 * Webhook + create-trip-after-payment finalize through one session row.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";

import {
  mutatePaymentSession,
} from "../../../functions/_shared/paymentSessionMutationCore.ts";

import {
  fromDbPaymentSessionStatus,
  isAuthorisedHoldSessionStatus,
  isBlockedForTripCreateSessionStatus,
  toDbPaymentSessionStatus,
  type RevolutPaymentSessionStatus,
} from "../../../functions/_shared/revolutPaymentHoldSSOT.ts";

import {
  RELEASE_EVIDENCE_SOURCE,
  buildResidualReleaseIdempotencyKey,
  classifyPostCaptureResidualReleaseEvidence,
  hasResidualReleaseIdempotencyKey,
  shouldSkipResidualReleasePersist,
} from "../../../functions/_shared/paymentSessionReleaseEvidenceSSOT.ts";

import { extractConfirmedReleaseAmountPence } from "../../../functions/_shared/paymentHoldProviderTerminalPure.ts";

import { extractProviderFeePence } from "../../../functions/_shared/paymentCaptureEvidenceSSOT.ts";

import {
  ADDITIONAL_AUTH_SOURCE,
  ADDITIONAL_AUTH_STATUS,
  buildAdditionalAuthIdempotencyKey,
  replacementTotalAuthorisedPence,
  type AdditionalAuthChildStatus,
} from "../../../functions/_shared/paymentSessionAdditionalAuthSSOT.ts";

import {
  classifyFeeStatus,
  sumRefundChildrenPence,
  FEE_STATUS,
} from "../../../functions/_shared/paymentSessionRefundFeeSSOT.ts";

import { notifyCustomerConfirmedRefund } from "../../../functions/_shared/customerRefundNotify.ts";
import { loadPaymentSession, markPaymentSessionStatus } from "../../../functions/_shared/paymentSessionSSOT.ts";


export async function markPaymentSessionPaymentShortfall(
  supabase: SupabaseClient,
  args: {
    clientActionId?: string | null;
    providerOrderId?: string | null;
    tripId: string;
    shortfallPence: number;
    reason: string;
    /** Slice 2: prefer PAYMENT_RECOVERY_REQUIRED for failed additional collection. */
    asPaymentRecovery?: boolean;
  },
): Promise<void> {
  const session = await loadPaymentSession(supabase, {
    clientActionId: args.clientActionId,
    providerOrderId: args.providerOrderId,
  });
  const metadata = session?.metadata && typeof session.metadata === "object"
    ? { ...(session.metadata as Record<string, unknown>) }
    : {};
  metadata.shortfall_pence = args.shortfallPence;
  if (args.asPaymentRecovery) {
    metadata.additional_auth_status = ADDITIONAL_AUTH_STATUS.PAYMENT_RECOVERY_REQUIRED;
  }

  const status: RevolutPaymentSessionStatus = args.asPaymentRecovery
    ? "PAYMENT_RECOVERY_REQUIRED"
    : "payment_shortfall";

  await markPaymentSessionStatus(supabase, status, args, {
    trip_id: args.tripId,
    failure_reason: args.reason,
    metadata,
  });
}

export * from "../../../functions/_shared/paymentSessionSSOT.ts";
