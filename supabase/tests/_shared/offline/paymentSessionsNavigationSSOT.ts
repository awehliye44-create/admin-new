/** Offline test/audit-only helpers; not part of Edge uploads. */
/**
 * Payment Sessions — lifecycle tabs (Captured, Released, Refunded, Recovery).
 * Customer/provider payment lifecycle only — no driver wallet or payout ownership.
 */
import type {
  AdminPaymentSessionsListRequest,
  AdminPaymentSessionsListRow,
  AdminPaymentSessionsSummary,
  AdminPaymentSessionsTab,
} from '../../../functions/_shared/adminPaymentSessionsSSOT.ts';

import {
  rowBelongsInCapturedTab,
  rowBelongsInRefundedTab,
  rowBelongsInReleasedTab,
} from '../../../functions/_shared/paymentSessionsDisplaySSOT.ts';

import {
  isVerifiedCurrentActiveHoldRow,
  rowNeedsActiveReleaseNow,
  rowNeedsManualRecoveryNow,
  rowNeedsReleaseFailedNow,
} from '../../../functions/_shared/paymentSessionsOperationalChipsSSOT.ts';
import { PAYMENT_SESSIONS_NAV_TABS, PaymentSessionsNavTab, LEGACY_TAB_MAP } from "../../../functions/_shared/paymentSessionsNavigationSSOT.ts";


/** Legacy ?tab= URLs → canonical lifecycle tabs. */
export function paymentSessionsLegacyTabRedirect(tab: string | null | undefined): string | null {
  if (!tab || PAYMENT_SESSIONS_NAV_TABS.includes(tab as PaymentSessionsNavTab)) return null;
  const mapped = tab ? LEGACY_TAB_MAP[tab] : null;
  if (!mapped) return '/payment-sessions?tab=captured';
  if (tab === 'active_holds') return '/payment-sessions?tab=captured&opFilter=active_holds';
  if (tab === 'failed_recovery') return '/payment-sessions?tab=recovery&opFilter=recovery_required';
  return `/payment-sessions?tab=${mapped}`;
}

export * from "../../../functions/_shared/paymentSessionsNavigationSSOT.ts";
export * from "../../../../shared/edgePresentation/paymentSessionsNavigationSSOT.ts";
