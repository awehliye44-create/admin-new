/** Admin presentation-only helpers; not part of Edge uploads. */
/**
 * Admin Payment Sessions (SSOT) — provider-neutral list contract.
 * Single edge: admin-payment-sessions. UI must not merge APIs client-side.
 */

import type { PaymentSessionActionPolicy, PaymentSessionPurpose } from "../../supabase/functions/_shared/paymentSessionPhase1SSOT.ts";

import type { PaymentHoldAttentionClass, PaymentHoldClassification } from "../../supabase/functions/_shared/paymentHoldReconciliation.ts";

import type { PaymentTripMatchStatus } from "../../supabase/functions/_shared/paymentSessionsTripMatchSSOT.ts";

import {
  paymentSessionsNavUrl,
  resolveLegacyPaymentSessionsTabMapping,
  type PaymentSessionsNavTab,
} from "../../supabase/functions/_shared/paymentSessionsNavigationSSOT.ts";
import { AdminPaymentSessionsTab } from "../../supabase/functions/_shared/adminPaymentSessionsSSOT.ts";


export const ADMIN_PAYMENT_SESSIONS_FN = "admin-payment-sessions";


export function paymentSessionsUrl(args?: {
  tab?: AdminPaymentSessionsTab | PaymentSessionsNavTab;
  paymentSessionId?: string | null;
  providerOrderId?: string | null;
  tripId?: string | null;
  customerId?: string | null;
  providerFeesPending?: boolean;
  captureFailed?: boolean;
  recoveryPending?: boolean;
  releaseFailed?: boolean;
  moneyAtRisk?: boolean;
  matchStatus?: PaymentTripMatchStatus;
}): string {
  if (!args) return '/payment-sessions?tab=captured';

  const mapped = args.tab != null
    ? resolveLegacyPaymentSessionsTabMapping(String(args.tab))
    : { navTab: 'captured' as PaymentSessionsNavTab };
  let navTab: PaymentSessionsNavTab = mapped.navTab;
  let opFilter: import('./paymentSessionsNavigationSSOT.ts').PaymentSessionsOpChip | undefined = mapped.opChip;

  if (args.captureFailed) opFilter = 'refund_failed';
  if (args.releaseFailed) opFilter = 'release_failed';
  if (args.recoveryPending) {
    navTab = 'recovery';
    opFilter = 'recovery_required';
  }
  if (args.moneyAtRisk) opFilter = 'release_failed';
  if (args.providerFeesPending) {
    navTab = 'captured';
  }

  return paymentSessionsNavUrl({
    tab: navTab,
    opFilter,
    paymentSessionId: args.paymentSessionId ?? undefined,
    providerOrderId: args.providerOrderId ?? undefined,
    tripId: args.tripId ?? undefined,
    customerId: args.customerId ?? undefined,
  });
}
